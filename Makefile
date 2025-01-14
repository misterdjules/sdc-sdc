#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2015, Joyent, Inc.
#

#
# Makefile for the 'sdc' zone
#

#
# Vars, Tools, Files, Flags
#
NAME		:= sdc
DOC_FILES	 = index.md sdc-amon-probes.md
JS_FILES	:= $(shell find lib test -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
RONNJS		 = $(NODE) ./node_modules/.bin/ronn
PERCENT		:= %

NODE_PREBUILT_VERSION=v0.10.29
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=zone
	# Allow building on a SmartOS image other than sdc-smartos@1.6.3.
	NODE_PREBUILT_IMAGE=fd2cc906-8938-11e3-beab-4359c665ac99
endif


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	NPM := $(shell which npm)
	NPM_EXEC=$(NPM)
endif

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.bz2
RELSTAGEDIR       := /tmp/$(STAMP)

MAN_PAGES = \
	man1/amqpsnoop.1 \
	man1/sdc-amon.1 \
	man1/sdc-amonrelay.1 \
	man1/sdc-cnapi.1 \
	man1/sdc-dirty-vms.1 \
	man1/sdc-fwapi.1 \
	man1/sdc-imgapi.1 \
	man1/sdc-ldap.1 \
	man1/sdc-napi.1 \
	man1/sdc-oneachnode.1 \
	man1/sdc-papi.1 \
	man1/sdc-sapi.1 \
	man1/sdc-vmapi.1 \
	man1/sdc-waitforjob.1 \
	man1/sdc-workflow.1

BUILD_MAN_FILES = $(MAN_PAGES:%=build/man/%)

CLEAN_FILES += build/man

#
# Targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) sdc-scripts sdc-napi-ufds-watcher
	$(NPM) install

.PHONY: man
man: $(BUILD_MAN_FILES)

build/man/%: man/%.ronn
	mkdir -p $(@D)
	$(RONNJS) --roff $^ \
	    --date `git log -1 --date=short --pretty=format:'$(PERCENT)cd' $^` \
	    `date +$(PERCENT)Y` \
	    > $@
	echo >> $@

.PHONY: hermes
hermes:
	cd deps/hermes && make install DESTDIR=$(TOP)/build/hermes

.PHONY: release
release: all docs man hermes sdc-napi-ufds-watcher
	@echo "Building $(RELEASE_TARBALL)"
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELSTAGEDIR)/site
	touch $(RELSTAGEDIR)/site/.do-not-delete-me
	mkdir -p $(RELSTAGEDIR)/root
	cp -r \
		$(TOP)/bin \
		$(TOP)/lib \
		$(TOP)/node_modules \
		$(TOP)/package.json \
		$(TOP)/sapi_manifests \
		$(TOP)/README.md \
		$(TOP)/CHANGES.md \
		$(TOP)/probes \
		$(TOP)/test \
		$(TOP)/tools \
		$(TOP)/build/man \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(TOP)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(TOP)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	cp -r \
		$(TOP)/build/node \
		$(TOP)/build/docs \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	cp -r $(TOP)/build/hermes/opt/smartdc/hermes \
		$(RELSTAGEDIR)/root/opt/smartdc/hermes
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/hermes/etc
	cp -r $(TOP)/deps/sdc-napi-ufds-watcher/ \
		$(RELSTAGEDIR)/root/opt/smartdc/napi-ufds-watcher
	cp $(TOP)/etc/logsets.json \
		$(RELSTAGEDIR)/root/opt/smartdc/hermes/etc
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

DISTCLEAN_FILES += node_modules

.PHONY: clean
distclean::
	cd deps/hermes && make clean
	cd deps/sdc-napi-ufds-watcher && make clean

.PHONY: distclean
distclean::
	cd deps/hermes && make clobber
	cd deps/napi-ufds-watcher && make clean



include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git

sdc-napi-ufds-watcher: deps/sdc-napi-ufds-watcher/.git
	cd deps/sdc-napi-ufds-watcher && make
