#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile for the 'sdc' zone
#

#
# Vars, Tools, Files, Flags
#
NAME		:= sdc
DOC_FILES	 = index.restdown
JS_FILES	:= $(shell find lib test -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
RONNJS		 = $(NODE) ./node_modules/.bin/ronn

NODE_PREBUILT_VERSION=v0.8.25
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_CC_VERSION=4.6.2
	NODE_PREBUILT_TAG=zone
endif


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.bz2
RELTMPDIR       := /tmp/$(STAMP)



#
# Targets
#
.PHONY: all
all: | $(NPM_EXEC) node_modules/bunyan/package.json sdc-scripts

node_modules/bunyan/package.json: | $(NPM_EXEC)
	$(NPM) install

.PHONY: force-npm-install
force-npm-install:
	$(NPM) install

.PHONY: man
man:
	for f in $(shell find man -name "*.ronn"); do \
		echo "Ronn'ing $$f"; \
		$(RONNJS) --roff --build $$f \
			--date $(shell git log -1 --date=short --pretty=format:'%cd' $$f) $(shell date +%Y); \
	done

.PHONY: hermes
hermes:
	cd deps/hermes && make install DESTDIR=$(TOP)/build/hermes

.PHONY: release
release: all docs man hermes
	@echo "Building $(RELEASE_TARBALL)"
	mkdir -p $(RELTMPDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELTMPDIR)/site
	touch $(RELTMPDIR)/site/.do-not-delete-me
	mkdir -p $(RELTMPDIR)/root
	cp -r \
		$(TOP)/bin \
		$(TOP)/lib \
		$(TOP)/node_modules \
		$(TOP)/package.json \
		$(TOP)/sapi_manifests \
		$(TOP)/README.md \
		$(TOP)/CHANGES.md \
		$(TOP)/test \
		$(TOP)/tools \
		$(RELTMPDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELTMPDIR)/root/opt/smartdc/$(NAME)/man
	for f in $$(cd man && find . -type f -name "*.roff"); do \
		mkdir -p $(RELTMPDIR)/root/opt/smartdc/$(NAME)/man/$$(dirname $$f); \
		cp man/$$f $(RELTMPDIR)/root/opt/smartdc/$(NAME)/man/$$(dirname $$f)/$$(basename $$f .roff); \
	done
	mkdir -p $(RELTMPDIR)/root/opt/smartdc/boot
	cp -R $(TOP)/deps/sdc-scripts/* $(RELTMPDIR)/root/opt/smartdc/boot/
	cp -R $(TOP)/boot/* $(RELTMPDIR)/root/opt/smartdc/boot/
	mkdir -p $(RELTMPDIR)/root/opt/smartdc/$(NAME)/build
	cp -r \
		$(TOP)/build/node \
		$(TOP)/build/docs \
		$(RELTMPDIR)/root/opt/smartdc/$(NAME)/build
	cp -r $(TOP)/build/hermes/opt/smartdc/hermes \
		$(RELTMPDIR)/root/opt/smartdc/hermes
	(cd $(RELTMPDIR) && $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELTMPDIR)

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

.PHONY: distclean
distclean::
	cd deps/hermes && make clobber



include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
