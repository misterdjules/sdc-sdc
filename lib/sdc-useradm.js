#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Work with SDC users (objectclass=sdcPerson in UFDS).
 *
 * TODO:
 * - sdc-useradm get --master   # option to look in the master, in case
 *   have bogus local diffs, e.g. when replicator is down
 * - sdc-useradm passwd <login|uuid> # if necessary
 * - sdc-useradm search [FIELD=VALUE]
 * - groups
 * - group NAME     # list members of the group
 * - group-add,add-to-group USER GROUP-NAME   # XXX don't like subcmd name
 *      sdc-useradm join-group <login|uuid> <group-name>
 *      sdc-useradm leave-group <login|uuid> <group-name>
 * - limits
 */

var VERSION = '1.1.0';

var p = console.log;
var fs = require('fs');
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var filters = require('ldapjs').filters;
var genUuid = require('node-uuid');
var read = require('read');
var sdcClients = require('sdc-clients'),
    UFDS = sdcClients.UFDS;
var sprintf = require('extsprintf').sprintf;
var tabula = require('tabula');
var vasync = require('vasync');

var common = require('../lib/common'),
    objMerge = common.objMerge,
    objCopy = common.objCopy;
var errors = require('../lib/errors');



//---- globals & config

var NAME = 'sdc-useradm';
var config = require('../etc/config.json');

var log = bunyan.createLogger({
    name: NAME,
    serializers: bunyan.stdSerializers,
    stream: process.stderr,
    level: 'warn'
});


//---- internal support stuff

/**
 * Convert a boolean or string representation (as in redis or UFDS or a
 * query param) into a boolean, or raise TypeError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value is `value` is undefined.
 * @param errName {String} The variable name to quote in the possibly
 *      raised TypeError.
 */
function boolFromString(value, default_, errName) {
    if (value === undefined) {
        return default_;
    } else if (value === 'false') {
        return false;
    } else if (value === 'true') {
        return true;
    } else if (typeof (value) === 'boolean') {
        return value;
    } else {
        throw new TypeError(
            format('invalid value for "%s": %j', errName, value));
    }
}


function printLdifField(field, value) {
    // Note: Intentionally NOT doing base64 for >80 cols.
    if (~value.indexOf('\n') || ~value.indexOf('\r') || /^\s+/.test(value) ||
        /\s+$/.test(value))
    {
        p('%s:: %s', field, new Buffer(value).toString('base64'));
    } else {
        p('%s: %s', field, value);
    }
}

/**
 * Return a sdcPerson "object" from the given raw UFDS data, i.e. massage
 * types appropriately.
 */
function sdcPersonFromUfds(raw) {
    var sdcPerson = objCopy(raw);
    delete sdcPerson.controls;
    sdcPerson.registered_developer = boolFromString(
        sdcPerson.registered_developer,
        undefined, 'registered_developer');
    sdcPerson.approved_for_provisioning = boolFromString(
        sdcPerson.approved_for_provisioning,
        undefined, 'approved_for_provisioning');
    ['pwdchangedtime',
     'pwdaccountlockedtime',
     'pwdfailuretime',
     'pwdendtime'].forEach(function (field) {
        if (Array.isArray(sdcPerson[field])) {
            for (var i = 0; i < sdcPerson[field].length; i++) {
                sdcPerson[field][i] = Number(sdcPerson[field][i]);
            }
        } else if (typeof (sdcPerson[field]) === 'string') {
            sdcPerson[field] = Number(sdcPerson[field]);
        }
    });
    ['created_at', 'updated_at'].forEach(function (field) {
        sdcPerson[field] = Number(sdcPerson[field]);
    });
}



//---- the CLI

function CLI() {
    Cmdln.call(this, {
        name: 'sdc-useradm',
        desc: 'Administer SDC users (and related objects) in UFDS',
        // Custom options. By default you get -h/--help.
        options: [
            {names: ['help', 'h'], type: 'bool', help: 'Print help and exit.'},
            {name: 'version', type: 'bool', help: 'Print version and exit.'},
            {names: ['verbose', 'v'], type: 'bool',
                help: 'Verbose/debug output.'}
        ],
        helpOpts: {
            includeEnv: true,
            minHelpCol: 23 /* line up with option help */
        }
    });
}
util.inherits(CLI, Cmdln);

// Custom `init` to handle custom options (i.e. 'version' defined above).
CLI.prototype.init = function (opts, args, callback) {
    if (opts.version) {
        p(this.name, VERSION);
        callback(false);
        return;
    }
    this.opts = opts;
    if (opts.verbose) {
        log.level('trace');
        log.src = true;
    }
    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.apply(this, arguments);
};


CLI.prototype._getUfdsClient = function (options, callback) {
    var client = new UFDS(options);

    client.once('error', callback);
    client.once('connect', function () {
        client.removeAllListeners('error');
        client.on('error', function (err) {
            options.log.error(err, 'UFDS disconnected');
        });
        client.on('connect', function () {
            options.log.info('UFDS reconnected');
        });
        callback(null, client);
    });
};

CLI.prototype.getLocalUfdsClient = function (callback) {
    var self = this;
    if (self._localUfdsClient) {
        return callback(null, self._localUfdsClient);
    }

    var options = {
        bindDN: 'cn=root',
        bindPassword: 'secret',
        log: log.child({ufds: 'local'}, true),
        url: 'ldaps://' + config.ufds_domain,
        connectTimeout: 15000,
        retry: {
            maxDelay: 10000,
            retries: 2
        }
    };
    self._getUfdsClient(options, function (err, client) {
        self._localUfdsClient = client;
        callback(err, client);
    });
};

CLI.prototype.getMasterUfdsClient = function (callback) {
    var self = this;
    if (config.ufds_is_master) {
        return self.getLocalUfdsClient(callback);
    } else if (self._masterUfdsClient) {
        return callback(null, self._masterUfdsClient);
    }

    var options = {
        bindDN: 'cn=root',
        bindPassword: 'secret',
        log: log.child({ufds: 'master'}, true),
        url: 'ldaps://' + config.ufds_remote_ip,
        connectTimeout: 10000,
        retry: {
            maxDelay: 10000,
            retries: 2
        }
    };
    self._getUfdsClient(options, function (err, client) {
        self._masterUfdsClient = client;
        callback(err, client);
    });
};


CLI.prototype.do_ping = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var getUfdsClient = (opts.master
        ? this.getMasterUfdsClient.bind(this)
        : this.getLocalUfdsClient.bind(this));
    getUfdsClient(function (cErr, client) {
        if (cErr)
            return callback(cErr);
        console.log('pong');
        callback();
    });
};
CLI.prototype.do_ping.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['master', 'm'],
        type: 'bool',
        help: 'Ping the master UFDS server.'
    }
];
CLI.prototype.do_ping.help = (
    'Ping the UFDS server.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} ping [<options>]\n'
    + '\n'
    + '{{options}}\n'
);


CLI.prototype.do_get = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 1) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var loginOrUuid = args[0];
    this.getLocalUfdsClient(function (cErr, client) {
        if (cErr)
            return callback(cErr);
        client.getUser(loginOrUuid, function (err, user) {
            if (err) {
                return callback(new errors.APIError(err));
            } else if (!user) {
                return callback(new errors.NoSuchUser(user));
            } else if (opts.ldif) {
                delete user.controls;
                var preferred = [
                    'dn',
                    'uuid',
                    'login',
                    'email',
                    'cn',
                    'givenname',
                    'sn'
                ];
                function preferredFirst(a, b) {
                    var aIdx = preferred.indexOf(a);
                    var bIdx = preferred.indexOf(b);
                    if (aIdx === -1 && bIdx !== -1) {
                        return 1;
                    } else if (aIdx !== -1 && bIdx === -1) {
                        return -1;
                    } else {
                        var aCmp = aIdx === -1 ? a : aIdx;
                        var bCmp = bIdx === -1 ? b : bIdx;
                        if (aCmp > bCmp) {
                            return 1;
                        } else if (aCmp === bCmp) {
                            return 0;
                        } else {
                            return -1;
                        }
                    }
                }
                Object.keys(user).sort(preferredFirst).forEach(function (fld) {
                    if (typeof (user[fld]) !== 'function') {
                        printLdifField(fld, user[fld]);
                    }
                });
            } else {
                delete user.controls;
                p(JSON.stringify(user, null, 2));
            }
            callback();
        });
    });
};
CLI.prototype.do_get.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['ldif', 'l'],
        type: 'bool',
        help: 'LDIF-like output.'
    }
];
CLI.prototype.do_get.help = (
    'Get a user.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} get [<options>] <login|uuid>\n'
    + '\n'
    + '{{options}}\n'
    + 'This emits in JSON by default.\n'
);


CLI.prototype.do_search = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length === 0) {
        return callback(new errors.UsageError('no search term(s) given'));
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    if (opts.long) {
        columns = ['uuid', 'login', 'cn', 'email', 'company', 'created_time'];
    }
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

    // Build the ldapjs filter for the given search args.
    var SEARCH_TYPE_FROM_FIELD = { // The allowed search fields.
        login: 'str',
        uuid: 'str',
        email: 'str',
        cn: 'str',
        sn: 'str',
        givenName: 'str',
        created_at: 'str',
        updated_at: 'str',
        pwdendtime: 'str',
        approved_for_provisioning: 'bool',
        registered_developer: 'bool',
        allowed_dcs: 'str'
    };
    var ldapFilter = new filters.AndFilter();
    ldapFilter.addFilter(new filters.EqualityFilter(
        {attribute: 'objectclass', value: 'sdcperson'}));
    var term; // used for relevance handling below
    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        /* JSSTYLED */
        var opParser = /^(\w+)\s*(=|>=|<=|!=|>|<|==)\s*(.*?)$/;
        var parsed = opParser.exec(arg);
        if (!parsed) {
            if (!term) {
                term = arg;
            }
            // Just a bare search term: match against login, uuid, cn and email.
            var or = new filters.OrFilter();
            or.addFilter(new filters.SubstringFilter(
                {attribute: 'login', initial: '', any: [arg]}));
            or.addFilter(new filters.EqualityFilter(
                {attribute: 'uuid', value: arg}));
            or.addFilter(new filters.SubstringFilter(
                {attribute: 'cn', initial: '', any: [arg]}));
            or.addFilter(new filters.SubstringFilter(
                {attribute: 'email', initial: '', any: [arg]}));
            ldapFilter.addFilter(or);
            continue;
        }
        var field = parsed[1];
        var op = parsed[2];
        var value = parsed[3];
        var parent = ldapFilter;
        var Filter;
        switch (op) {
        case '=':
            Filter = filters.EqualityFilter;
            break;
        case '>=':
            Filter = filters.GreaterThanEqualsFilter;
            break;
        case '<=':
            Filter = filters.LessThanEqualsFilter;
            break;
        case '!=':
            Filter = filters.EqualityFilter;
            parent = new filters.NotFilter();
            ldapFilter.addFilter(parent);
            break;
        case '==':
            throw new Error('"==" operator not supported, use "="');
        case '<':
            throw new Error('"<" operator not supported, use "<="');
        case '>':
            throw new Error('">" operator not supported, use ">="');
        default:
            throw new Error('unknown operator: ' + op);
        }
        switch (SEARCH_TYPE_FROM_FIELD[field]) {
        case 'str':
            // Note: Not being careful about escaped asterisks here.
            var starIdx = value.indexOf('*');
            if (starIdx === -1) {
                parent.addFilter(new Filter(
                        {attribute: field, value: value}));
            } else {
                // Note: Really want negative lookbehind assertions to skip
                // escaped asterisks. E.g. /(?<!\\)\*+/
                var parts = value.split(/\*+/);
                parent.addFilter(new filters.SubstringFilter({
                    attribute: field,
                    initial: parts[0],
                    any: parts.slice(1, -1),
                    final: parts[parts.length-1]
                }));
            }
            break;
        case 'array':
            for (var j = 0; j < value.length; j++) {
                parent.addFilter(new Filter(
                    {attribute: field, value: value[j]}));
            }
            break;
        case 'bool':
            var boolValue = boolFromString(value, undefined, field);
            parent.addFilter(new filters.EqualityFilter(
                {attribute: field, value: boolValue.toString()}));
            break;
        default:
            throw new Error(sprintf('unknown filter field: "%s"', field));
        }
    }

    log.debug({ldapFilter: ldapFilter.toString()}, 'ldap filter');
    var base = 'ou=users, o=smartdc';
    var searchOpts = {
        scope: 'one',
        filter: ldapFilter.toString()
    };
    this.getLocalUfdsClient(function (cErr, client) {
        if (cErr)
            return callback(cErr);
        client.search(base, searchOpts, function (err, entries) {
            if (err)
                return callback(err);

            var k;
            var sdcPersons = [];
            for (k = 0; k < entries.length; k++) {
                try {
                    sdcPersons.push(sdcPersonFromUfds(entries[k]));
                } catch (sdcPersonErr) {
                    console.warn('skipping sdcPerson with invalid raw UFDS '
                        + 'data: %s (raw data: %j)', sdcPersonErr, entries[k]);
                }
            }
            if (opts.json) {
                p(JSON.stringify(entries, null, 2));
            } else {
                for (k = 0; k < entries.length; k++) {
                    var e = entries[k];
                    if (e.created_at) {
                        // Examples in us-beta-4 of *multiple* created_at values
                        // on some sdcPerson entries.
                        if (Array.isArray(e.created_at)) {
                            // Let's take the earlier one. This is a gray area.
                            e.created_at = e.created_at
                                .map(function (item) { return Number(item); })
                                .sort()[0];
                        }
                        e.created_time = (new Date(Number(e.created_at)))
                            .toISOString();
                        e.created = e.created_time.slice(0, 10);
                    }
                    if (e.updated_at) {
                        // Examples in us-beta-4 of *multiple* updated_at values
                        // on some sdcPerson entries.
                        if (Array.isArray(e.updated_at)) {
                            // Let's take the later one.
                            e.updated_at = e.updated_at.map(
                                function (item) { return Number(item); }
                                ).sort().slice(-1)[0];
                        }
                        e.updated_time = (new Date(Number(e.updated_at)))
                            .toISOString();
                        e.updated = e.updated_time.slice(0, 10);
                    }
                    // Note: Relevance handling was added when search only
                    // supported a single 'term' arg. Now we have more so this
                    // relevance calculation should be beefed up.
                    if (!term) {
                        e.relevance = 1;
                    } else if (e.login === term || e.uuid === term ||
                               e.cn === term || e.email === term) {
                        e.relevance = 1;
                    } else {
                        e.relevance = Math.max(
                            ~e.login.indexOf(term) &&
                                term.length / e.login.length,
                            ~(e.cn || '').indexOf(term) &&
                                term.length / e.cn.length,
                            ~e.email.indexOf(term) &&
                                term.length / e.email.length
                        );
                    }
                }
                // TODO: svn-like status field showing registered_developer,
                // approved_for_provisioning, member of operators, etc. Op
                // group check is more expensive tho, so not by default and
                // lazy. Or could use mahi for that search?
                tabula(entries, {
                    skipHeader: opts.H,
                    columns: columns,
                    sort: sort
                });
            }

            callback();
        });
    });
};
CLI.prototype.do_search.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output.'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Do not print table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'uuid,login,email,created',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-relevance,login',
        help: 'Sort on the given fields. Default is "-relevance,login".',
        helpArg: 'field1,...'
    },
    {
        names: ['long', 'l'],
        type: 'bool',
        help: 'Longer table output. Shortcut for '
            + '"-o uuid,login,cn,email,company,created_time".'
    }
];
CLI.prototype.do_search.help = (
    'Search users.\n'
    + '\n'
    + 'Usage:\n'
    + '    {{name}} search [<options>] <terms...>\n'
    + '\n'
    + '{{options}}\n'
    + 'The search term is either a plain string -- which does a\n'
    + '(case-sensitive) match of login (substring), uuid, cn (substring) and\n'
    + 'email (substring) -- or a field-scoped comparison of the form\n'
    + '<field><op><value> -- e.g. "login=admin". Supported operators are:\n'
    + '\n'
    + '    foo=bar\n'
    + '    foo!=bar\n'
    + '    foo>=123\n'
    + '    foo<=bar\n'
    + '\n'
    + 'Substring matching is supported as well:\n'
    + '\n'
    + '    foo=*bar*\n'
    + '\n'
    + 'Results are limited by UFDS to 1000?'
);


CLI.prototype.do_create = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    }

    var userpasswordField = {
        name: 'userpassword',
        hidden: true,
        confirm: true,
        prompt: true,
        required: true
    };
    var fields = [
        {
            name: 'login',
            required: true,
            prompt: true
        },
        {
            name: 'email',
            required: true,
            prompt: true
        },
        userpasswordField,
        {
            name: 'cn',
            prompt: true
        },
        { name: 'company' },
        { name: 'address' },
        { name: 'city' },
        { name: 'state' },
        { name: 'postalCode' },
        { name: 'country' },
        { name: 'phone' }
    ];

    function readField(field, default_, cb) {
        if (cb === undefined) {
            cb = default_;
            default_ = undefined;
        }
        assert.object(field, 'field');
        assert.func(cb);
        //TODO: 'required', don't allow empty string
        var readOpts = {
            prompt: field.name + ':',
            silent: field.hidden,
            default: default_
        };
        read(readOpts, function (rErr, val) {
            if (rErr)
                return cb(rErr);
            val = val.trim();
            if (!field.confirm) {
                cb(null, val);
            } else {
                readOpts.prompt = field.name + ' confirm:';
                read(readOpts, function (rErr2, val2) {
                    if (rErr2)
                        return cb(rErr2);
                    val2 = val2.trim();
                    if (val !== val2) {
                        cb(new Error(sprintf(
                            '%s values do not match', field.name)));
                    } else {
                        cb(null, val);
                    }
                });
            }
        });
    }

    var data = {};
    if (opts.approved_for_provisioning) {
        data['approved_for_provisioning'] = true;
    }

    var client;
    async.series([
        function dataFromStdin(next) {
            if (opts.i || opts.f || args.length > 0) {
                return next();
            }
            var stdin = '';
            process.stdin.resume();
            process.stdin.on('data', function (chunk) {
                stdin += chunk;
            });
            process.stdin.on('end', function () {
                try {
                    objMerge(data, JSON.parse(stdin));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data on stdin: %s', ex)));
                }
            });
        },
        function dataFromFile(next) {
            if (!opts.f) {
                return next();
            } else if (opts.i) {
                return next(new errors.UsageError(
                    'cannot use both "-i" and "-f" options'));
            } else if (args.length > 0) {
                return next(new errors.UsageError(
                    'cannot specify args and the "-f" option'));
            }
            fs.readFile(opts.f, function (rErr, content) {
                try {
                    objMerge(data, JSON.parse(content));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data in "%s": %s', opts.f, ex)));
                }
            });
        },
        function dataFromArgs(next) {
            if (args.length === 0) {
                return next();
            }
            for (var i = 0; i < args.length; i++) {
                var arg = args[i];
                var idx = arg.indexOf('=');
                if (idx === -1) {
                    return next(new errors.UsageError(sprintf(
                        'invalid field arg "%s": must match '
                        + '"<field>=<value>"', arg)));
                }
                var field = arg.slice(0, idx);
                var value = arg.slice(idx + 1);
                try {
                    value = JSON.parse(value);
                } catch (e) {}
                data[field] = value;
            }
            next();
        },
        function dataFromPrompting(next) {
            if (!opts.i) {
                return next();
            }
            async.eachSeries(fields, function askField(field, nextField) {
                if (!field.prompt && !opts.all) {
                    return nextField();
                }
                readField(field, data[field.name], function (rfErr, val) {
                    if (rfErr)
                        return nextField(rfErr);
                    if (val) {
                        data[field.name] = val;
                    }
                    nextField();
                });
            }, next);
        },
        function ensureFields(next) {
            if (data.memberof) {
                return next(new errors.UsageError(
                    'cannot set "memberof" in user creation'));
            }
            data.objectclass = 'sdcperson';
            if (!data.uuid) {
                data.uuid = genUuid();
            }
            if (data.cn && !data.sn && !data.givenName) {
                var idx = data.cn.trimRight().lastIndexOf(' ');
                if (idx !== -1) {
                    data.sn = data.cn.slice(idx).trim();
                    data.givenName = data.cn.slice(0, idx).trim();
                }
            }
            var now = Date.now();
            if (!data.created_at) {
                data.created_at = now;
            }
            if (!data.updated_at) {
                data.updated_at = now;
            }
            next();
        },
        function getClient(next) {
            self.getMasterUfdsClient(function (cErr, client_) {
                if (cErr)
                    return callback(cErr);
                client = client_;
                next();
            });
        },
        function addUser(next) {
            var dn = sprintf('uuid=%s, ou=users, o=smartdc', data.uuid);
            var attempts = 0;
            var retry;
            async.doWhilst(
                function addUserAttempt(nextAttempt) {
                    attempts += 1;
                    client.add(dn, data, function (aErr) {
                        /**
                         * Grr, UFDS errors put the relevant differentiator
                         * in the "message" field. E.g.:
                         *      {
                         *        "message": "passwordTooShort",
                         *        "statusCode": 409,
                         *        "body": {
                         *          "code": "InvalidArgument",
                         *          "message": "passwordTooShort"
                         *        },
                         *        "restCode": "InvalidArgument"
                         *      }
                         */
                        var retryErrs = {
                            'passwordTooShort': true,
                            'insufficientPasswordQuality': true
                        };
                        if (opts.i &&
                            attempts < 3 &&
                            aErr && aErr.statusCode === 409 &&
                            retryErrs[aErr.message])
                        {
                            retry = true;
                            p('* * *');
                            p('Error with password: %s (retry)', aErr.message);
                            readField(userpasswordField, function (rfErr, val) {
                                if (rfErr)
                                    return nextAttempt(rfErr);
                                data[userpasswordField.name] = val;
                                nextAttempt();
                            });
                        } else {
                            retry = false;
                            nextAttempt(aErr);
                        }
                    });
                },
                function () { return retry; },
                next);
        },
        function (next) {
            p('User %s (login "%s") created', data.uuid, data.login);
            next();
        },
        function closeClient(next) {
            client.close(next);
        }
    ], callback);
};
CLI.prototype.do_create.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        name: 'f',
        type: 'string',
        help: 'JSON file with user data.'
    },
    {
        name: 'i',
        type: 'bool',
        help: 'Interactively prompt for fields.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'If used with "-i" will prompt for all user fields. By default '
            + 'only the most common fields are prompted.'
    },
    {
        names: ['approved-for-provisioning', 'A'],
        type: 'bool',
        help: 'Approve this user for provisioning, i.e. enable the account.'
    }
];
/* BEGIN JSSTYLED */
CLI.prototype.do_create.help = (
    'Create a new user.\n'
    + '\n'
    + 'Usage:\n'
    + '     ...stdin... | {{name}} create            # 1. data as JSON on stdin\n'
    + '     {{name}} create -f foo.json              # 2. data in JSON file\n'
    + '     {{name}} create <field>=<value>...       # 3. all fields as args\n'
    + '     {{name}} create -i [<field>=<value>...]  # 4. prompt for fields\n'
    + '\n'
    + '{{options}}\n'
);
/* END JSSTYLED */


CLI.prototype.do_replace_attr = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 3) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var loginOrUuid = args[0];
    var attr = args[1];
    var value = args[2];

    vasync.pipeline({arg: {}, funcs: [
        /* @field ctx.client */
        function getClient(ctx, next) {
            self.getMasterUfdsClient(function (err, client) {
                if (err) {
                    return next(err);
                }
                ctx.client = client;
                next();
            });
        },
        /* @field ctx.user */
        function getUser(ctx, next) {
            ctx.client.getUser(loginOrUuid, function (err, user) {
                if (err) {
                    next(new errors.APIError(err));
                } else if (!user) {
                    next(new errors.NoSuchUser(user));
                } else {
                    ctx.user = user;
                    next();
                }
            });
        },
        function updateUser(ctx, next) {
            /*
             * <ufdsClient>.updateUser() doesn't support 'add' modification
             * type, so we are skipping using it for the '*-attr' commands.
             */
            var change = {
                type: 'replace',
                modification: {}
            };
            change.modification[attr] = value;
            ctx.client.modify(ctx.user.dn, [change], next);
        },
        function print(ctx, next) {
            p('Replaced attribute on user %s (%s): %s=%s', ctx.user.uuid,
                ctx.user.login, attr, value);
            next();
        },
        function closeClient(ctx, next) {
            ctx.client.close(next);
        }
    ]}, callback);
};
CLI.prototype.do_replace_attr.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_replace_attr.help = (
    'Replace/set an attribute on a user.\n'
    + 'Note: Overuse of custom attributes to UFDS users is discouraged.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} replace-attr <login|uuid> <attr> <value>\n'
    + '\n'
    + '{{options}}'
);


CLI.prototype.do_add_attr = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length < 3) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var loginOrUuid = args[0];
    var attr = args[1];
    var values = args.slice(2);

    vasync.pipeline({arg: {}, funcs: [
        /* @field ctx.client */
        function getClient(ctx, next) {
            self.getMasterUfdsClient(function (err, client) {
                if (err) {
                    return next(err);
                }
                ctx.client = client;
                next();
            });
        },
        /* @field ctx.user */
        function getUser(ctx, next) {
            ctx.client.getUser(loginOrUuid, function (err, user) {
                if (err) {
                    next(new errors.APIError(err));
                } else if (!user) {
                    next(new errors.NoSuchUser(user));
                } else {
                    ctx.user = user;
                    next();
                }
            });
        },
        function updateUser(ctx, next) {
            /*
             * <ufdsClient>.updateUser() doesn't support 'add' modification
             * type, so we are skipping using it for the '*-attr' commands.
             */
            var change = {
                type: 'add',
                modification: {}
            };
            change.modification[attr] = values;
            ctx.client.modify(ctx.user.dn, [change], next);
        },
        function print(ctx, next) {
            p('Added attribute on user %s (%s): %s=%s', ctx.user.uuid,
                ctx.user.login, attr, values.join(', '));
            next();
        },
        function closeClient(ctx, next) {
            ctx.client.close(next);
        }
    ]}, callback);
};
CLI.prototype.do_add_attr.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_add_attr.help = (
    'Add an attribute on a user.\n'
    + 'This allows having multiple values for the same attribute name.\n'
    + 'If you want only a single value, use "sdc-useradm replace-attr".\n'
    + '\n'
    + 'Note: Overuse of custom attributes to UFDS users is discouraged.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} add-attr <login|uuid> <attr> <value> [<value>...]\n'
    + '\n'
    + '{{options}}'
);


CLI.prototype.do_delete_attr = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 3 && args.length !== 2) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var loginOrUuid = args[0];
    var attr = args[1];
    var value = args[2];
    if (opts.all && value) {
        return callback(new errors.UsageError(sprintf(
            '-a|--all and <value> are mutually exclusive')));
    }

    vasync.pipeline({arg: {}, funcs: [
        /* @field ctx.client */
        function getClient(ctx, next) {
            self.getMasterUfdsClient(function (err, client) {
                if (err) {
                    return next(err);
                }
                ctx.client = client;
                next();
            });
        },
        /* @field ctx.user */
        function getUser(ctx, next) {
            ctx.client.getUser(loginOrUuid, function (err, user) {
                if (err) {
                    next(new errors.APIError(err));
                } else if (!user) {
                    next(new errors.NoSuchUser(user));
                } else {
                    ctx.user = user;
                    next();
                }
            });
        },
        function validateDelete(ctx, next) {
            var existing = ctx.user[attr];
            if (!existing) {
                return next(new errors.NoSuchAttributeError(loginOrUuid, attr));
            }
            if (value && (Array.isArray(existing) ?
                existing.indexOf(value) === -1 : existing !== value))
            {
                return next(new errors.NoSuchValueError(loginOrUuid, attr,
                    value));
            }
            if (!value && !opts.all && Array.isArray(existing) &&
                existing.length > 1)
            {
                return next(new errors.UsageError(sprintf('user "%s" ' +
                    'attribute "%s" has multiple values (specify or use --all)',
                    loginOrUuid, attr)));
            }

            next();
        },
        function updateUser(ctx, next) {
            /*
             * <ufdsClient>.updateUser() doesn't support 'add' modification
             * type, so we are skipping using it for the '*-attr' commands.
             */
            var change = {
                type: 'delete',
                modification: {}
            };
            if (value) {
                change.modification[attr] = value;
            } else {
                change.modification[attr] = ctx.user[attr];
            }
            ctx.client.modify(ctx.user.dn, change, next);
        },
        function print(ctx, next) {
            if (opts.all) {
                p('Deleted all attribute "%s" values from user %s (%s)',
                    attr, ctx.user.uuid, ctx.user.login);
            } else if (value) {
                p('Deleted attribute "%s=%s" from user %s (%s)',
                    attr, value, ctx.user.uuid, ctx.user.login);
            } else {
                p('Deleted attribute "%s" from user %s (%s)',
                    attr, ctx.user.uuid, ctx.user.login);
            }
            next();
        },
        function closeClient(ctx, next) {
            ctx.client.close(next);
        }
    ]}, callback);
};
CLI.prototype.do_delete_attr.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'Delete all attribute values from the user.'
    }
];
CLI.prototype.do_delete_attr.help = (
    'Delete an attribute on a user.\n'
    + 'This allows having multiple values for the same attribute name.\n'
    + 'If you want only a single value, use "sdc-useradm replace-attr".\n'
    + '\n'
    + 'Note: Overuse of custom attributes to UFDS users is discouraged.\n'
    + '\n'
    + 'Usage:\n'
    + '     # Delete an attribute with a single value.\n'
    + '     {{name}} delete-attr <login|uuid> <attr>\n'
    + '     # Delete a specific attribute value from the user.\n'
    + '     {{name}} delete-attr <login|uuid> <attr> <value>\n'
    + '     # Delete all attribute values from the user.\n'
    + '     {{name}} delete-attr -a <login|uuid> <attr>\n'
    + '\n'
    + '{{options}}'
);


CLI.prototype.do_add_key = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 2) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var loginOrUuid = args[0];
    var pubkeyPath = args[1];

    var client;
    var key;
    var pubkey;
    async.series([
        function readPubkey(next) {
            // Guard
            if (!opts.force && pubkeyPath.slice(-4) !== '.pub') {
                return next(new errors.UsageError(sprintf(
                    'pubkey file, "%s", does not end in ".pub": aborting in '
                    + 'case this is accidentally a private key file (use '
                    + '"--force" to override)', pubkeyPath)));
            }
            fs.readFile(pubkeyPath, 'ascii', function (err, content) {
                pubkey = content;
                next(err);
            });
        },
        function getClient(next) {
            self.getMasterUfdsClient(function (cErr, client_) {
                if (cErr)
                    return callback(cErr);
                client = client_;
                next();
            });
        },
        function addKey(next) {
            var keyData = {
                openssh: pubkey
            };
            if (opts.name) {
                keyData.name = opts.name;
            }
            client.addKey(loginOrUuid, keyData, function (err, key_) {
                key = key_;
                next(err);
            });
        },
        function print(next) {
            p('Key "%s" added to user "%s"', key.name, loginOrUuid);
            next();
        },
        function closeClient(next) {
            client.close(next);
        }
    ], callback);
};
CLI.prototype.do_add_key.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['name', 'n'],
        type: 'string',
        help: 'A name for the key. Defaults to the pubkey fingerprint.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Force allow a pubkey path that does not end in ".pub". By '
            + 'this is disallowed to guard against accidental usage of a '
            + 'private key file.'
    }
];
CLI.prototype.do_add_key.help = (
    'Add a key to a user.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} add-key [<options>] <login|uuid> <path-to-pubkey>\n'
    + '\n'
    + '{{options}}'
);

CLI.prototype.do_delete_key = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 2) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var loginOrUuid = args[0];
    var keyNameOrFp = args[1];

    var client;
    async.series([
        function getClient(next) {
            self.getMasterUfdsClient(function (cErr, client_) {
                if (cErr)
                    return callback(cErr);
                client = client_;
                next();
            });
        },
        function deleteKey(next) {
            client.deleteKey(loginOrUuid, keyNameOrFp, next);
        },
        function print(next) {
            p('Key "%s" deleted from user "%s"', keyNameOrFp, loginOrUuid);
            next();
        },
        function closeClient(next) {
            client.close(next);
        }
    ], callback);
};
CLI.prototype.do_delete_key.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_delete_key.help = (
    'Delete a key from a user.\n'
    + '\n'
    + 'Usage:\n'
    /* JSSTYLED */
    + '     {{name}} delete-key [<options>] <login|uuid> <key-name-or-fingerprint>\n'
    + '\n'
    + '{{options}}'
);


CLI.prototype.do_keys = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 1) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var loginOrUuid = args[0];

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

    var client;
    var keys;
    async.series([
        function getClient(next) {
            self.getLocalUfdsClient(function (cErr, client_) {
                if (cErr)
                    return callback(cErr);
                client = client_;
                next();
            });
        },
        function listKeys(next) {
            client.listKeys(loginOrUuid, function (err, keys_) {
                if (err) {
                    next(new errors.APIError(err));
                } else {
                    keys = keys_;
                    for (var i = 0; i < keys.length; i++) {
                        delete keys[i].controls;
                    }
                    next();
                }
            });
        },
        function print(next) {
            if (opts.json) {
                p(JSON.stringify(keys, null, 2));
            } else {
                tabula(keys, {
                    skipHeader: opts.H,
                    columns: columns,
                    sort: sort
                });
            }
            next();
        },
        function closeClient(next) {
            client.close(next);
        }
    ], callback);
};
CLI.prototype.do_keys.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output.'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Do not print table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'name,fingerprint',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: 'name',
        help: 'Sort on the given fields. Default is "name".',
        helpArg: 'field1,...'
    }
];
CLI.prototype.do_keys.help = (
    'List a user\'s keys.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} keys [<options>] <login|uuid>\n'
    + '\n'
    + '{{options}}'
);


CLI.prototype.do_key = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 2) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var loginOrUuid = args[0];
    var keyNameOrFp = args[1];

    var client;
    var key;
    async.series([
        function getClient(next) {
            self.getLocalUfdsClient(function (cErr, client_) {
                if (cErr)
                    return callback(cErr);
                client = client_;
                next();
            });
        },
        function getKey(next) {
            client.getKey(loginOrUuid, keyNameOrFp, function (err, key_) {
                if (err && err.statusCode === 404) {
                    next(new errors.NoSuchKeyError(
                        err, loginOrUuid, keyNameOrFp));
                } else if (err) {
                    next(new errors.APIError(err));
                } else {
                    key = key_;
                    delete key.controls;
                    next();
                }
            });
        },
        function print(next) {
            if (opts.ldif) {
                Object.keys(key).forEach(function (field) {
                    if (typeof (key[field]) !== 'function') {
                        printLdifField(field, key[field]);
                    }
                });
            } else {
                p(JSON.stringify(key, null, 2));
            }
            next();
        },
        function closeClient(next) {
            client.close(next);
        }
    ], callback);
};
CLI.prototype.do_key.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['ldif', 'l'],
        type: 'bool',
        help: 'LDIF-like output.'
    }
];
CLI.prototype.do_key.help = (
    'Get a user\'s key by name or fingerprint.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} key [<options>] <login|uuid> <key-name-or-fingerprint>\n'
    + '\n'
    + '{{options}}'
);


//---- mainline

if (require.main === module) {
    var cli = new CLI();
    cli.main(process.argv, function (err, subcmd) {
        if (err) {
            var subcmdStr = subcmd ? ' ' + subcmd : '';
            var code = (err.body ? err.body.code : err.code);
            if (code) {
                console.error('%s%s: error (%s): %s', cli.name, subcmdStr,
                    code, err.message);
            } else {
                console.error('%s%s: error: %s', cli.name, subcmdStr,
                    err.message);
            }
            if (cli.opts.verbose && err.stack) {
                console.error('\n' + err.stack);
            }
            process.exit(err.exitStatus !== undefined ? err.exitStatus : 1);
        } else {
            process.exit(0);
        }
    });
}
