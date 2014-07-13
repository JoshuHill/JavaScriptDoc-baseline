/*
    Copyright 2014 Google Inc. All rights reserved.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
'use strict';

var _ = require('underscore-contrib');
var beautify = require('js-beautify').html;
var Filter = require('jsdoc/src/filter').Filter;
var fs = require('jsdoc/fs');
var helper = require('jsdoc/util/templateHelper');
var logger = require('jsdoc/util/logger');
var name = require('jsdoc/name');
var path = require('jsdoc/path');
var Scanner = require('jsdoc/src/scanner').Scanner;
var Swig = require('swig').Swig;
var taffy = require('taffydb').taffy;
var util = require('util');

var hasOwnProp = Object.prototype.hasOwnProperty;

var CONFIG_KEY = exports.CONFIG_KEY = 'baseline';

var CATEGORIES = exports.CATEGORIES = {
    CLASSES: 'classes',
    EVENTS: 'events',
    EXTERNALS: 'externals',
    FUNCTIONS: 'functions',
    GLOBALS: 'globals',
    LISTENERS: 'listeners',
    MEMBERS: 'members',
    MIXINS: 'mixins',
    MODULES: 'modules',
    NAMESPACES: 'namespaces',
    PACKAGES: 'packages',
    TYPEDEFS: 'typedefs'
};

// Categories that require a separate output file for each longname.
var OUTPUT_FILE_CATEGORIES = [
    CATEGORIES.CLASSES,
    CATEGORIES.EXTERNALS,
    CATEGORIES.MIXINS,
    CATEGORIES.MODULES,
    CATEGORIES.NAMESPACES
];

// TODO: belongs in a resource file (or at least in the views)
var PAGE_TITLES = exports.PAGE_TITLES = {};
PAGE_TITLES[CATEGORIES.CLASSES] = 'Class: ';
PAGE_TITLES[CATEGORIES.EXTERNALS] = 'External: ';
PAGE_TITLES[CATEGORIES.GLOBALS] = 'Globals';
PAGE_TITLES[CATEGORIES.MIXINS] = 'Mixin: ';
PAGE_TITLES[CATEGORIES.MODULES] = 'Module: ';
PAGE_TITLES[CATEGORIES.NAMESPACES] = 'Namespace: ';
PAGE_TITLES[CATEGORIES.SOURCES] = 'Source: ';
PAGE_TITLES[CATEGORIES.TUTORIALS] = 'Tutorial: ';


// Tracks ALL doclets by category (similar, but not identical, to their "kind")
// TODO: export?
function SymbolTracker() {
    var category;

    var categories = Object.keys(CATEGORIES);

    for (var i = 0, l = categories.length; i < l; i++) {
        category = CATEGORIES[categories[i]];
        this[category] = [];
    }
}

SymbolTracker.prototype.add = function add(doclet, category) {
    if (hasOwnProp.call(this, category)) {
        this[category].push(doclet);
    }
};

SymbolTracker.prototype.get = function get(category) {
    if (hasOwnProp.call(this, category)) {
        return this[category];
    }
};

SymbolTracker.prototype.hasDoclets = function hasDoclets(category) {
    var current;

    var categories = category ? [category] : Object.keys(CATEGORIES);
    var result = false;

    for (var i = 0, l = categories.length; i < l; i++) {
        current = CATEGORIES[categories[i]];

        if (current && this[current].length) {
            result = true;
            break;
        }
    }

    return result;
};

// TODO: try to avoid storing taffyData in any form--doclets only!
var DocletHelper = exports.DocletHelper = function DocletHelper(taffyData) {
    // TODO: move to addDoclets?
    // TODO: make these steps configurable (especially sorting!)
    this.data = helper.prune(taffyData);
    this.data.sort('longname, version, since');

    // Doclets tracked by longname
    this.longname = {};
    // Doclets tracked by memberof
    this.memberof = {};
    // Global doclets
    this.globals = new SymbolTracker();
    // Listeners tracked by event longname
    this.listeners = {};
    // TODO: could we track this by longname or something?
    this.moduleExports = [];
    // Longnames of doclets that need their own output file
    this.needsFile = {};
    this.navTree = {};
    this.shortPaths = {};
    this.symbols = new SymbolTracker();

    this._sourcePaths = [];
};

function isModuleDoclet(doclet) {
    var MODULE_PREFIX = name.MODULE_PREFIX;

    return doclet.longname && doclet.longname === doclet.name &&
        doclet.longname.indexOf(MODULE_PREFIX) === 0;
}

// TODO: it would be nice if JSDoc added scope: "global" for all of these, so the template didn't
// have to infer this from the lack of a memberof...
// TODO: think carefully about whether these are the only symbols that should appear as global. For
// example, why not show a global class as such?
function isGlobal(doclet) {
    var globalKinds = ['member', 'function', 'constant', 'typedef'];

    if (!doclet.memberof && globalKinds.indexOf(doclet.kind) !== -1) {
        return true;
    }

    return false;
}

// TODO: rename?
DocletHelper.prototype._trackByCategory = function _trackByCategory(doclet, category) {
    var longname = doclet.longname;
    var self = this;

    if (isGlobal(doclet)) {
        // Only track the doclet as a global; we don't want it to appear elsewhere
        this.globals.add(doclet, category);
    }
    else if (longname) {
        // Track the doclet by its longname. Also, if the doclet is a member of something else,
        // track it by its memberof value, so we can easily retrieve all of the members later.
        ['longname', 'memberof'].forEach(function(prop) {
            var docletValue = doclet[prop];

            if (docletValue) {
                self[prop][docletValue] = self[prop][docletValue] || new SymbolTracker();
                self[prop][docletValue].add(doclet, category);
            }
        });

        // Keep track of longnames that require their own output file. By creating this list now,
        // we make it efficient to extract the correct doclets from this.longname later.
        if (longname && OUTPUT_FILE_CATEGORIES.indexOf(category) !== -1) {
            this.needsFile[longname] = true;
        }
    }

    return this;
};

DocletHelper.prototype._trackListeners = function _trackListeners(doclet) {
    // TODO: shouldn't JSDoc do this? does it already?
    var listens = doclet.listens || [];
    var self = this;

    listens.forEach(function(longname) {
        self.listeners[longname] = self.listeners[longname] || new SymbolTracker();
        self.listeners[longname].add(doclet, CATEGORIES.LISTENERS);
    });
};

function _findCategory(doclet) {
    var category;

    switch (doclet.kind) {
        case 'class':
            if (!isModuleDoclet(doclet)) {
                category = CATEGORIES.CLASSES;
            }
            break;

        case 'constant':
            category = CATEGORIES.MEMBERS;
            break;

        case 'event':
            category = CATEGORIES.EVENTS;
            break;

        case 'external':
            category = CATEGORIES.EXTERNALS;
            break;

        case 'function':
            if (!isModuleDoclet(doclet)) {
                category = CATEGORIES.FUNCTIONS;
            }
            break;

        case 'member':
            category = CATEGORIES.MEMBERS;
            break;

        case 'mixin':
            category = CATEGORIES.MIXINS;
            break;

        case 'module':
            category = CATEGORIES.MODULES;
            break;

        case 'namespace':
            category = CATEGORIES.NAMESPACES;
            break;

        case 'package':
            category = CATEGORIES.PACKAGES;
            break;

        case 'typedef':
            category = CATEGORIES.TYPEDEFS;
            break;

        default:
            // ignore
            break;
    }

    return category;
}

// TODO: rename
// TODO: can we move the doclet-munging elsewhere?
DocletHelper.prototype._categorize = function _categorize(doclet) {
    var category = _findCategory(doclet);
    var moduleExports = this.moduleExports;
    var symbols = this.symbols;

    // Do some minor pre-processing
    switch (doclet.kind) {
        case 'class':
            if (isModuleDoclet(doclet)) {
                moduleExports.push(doclet);
            }
            break;

        case 'constant':
            doclet.kind = 'member';
            break;

        case 'external':
            // strip quotes from externals, since we allow quoted names that would normally indicate
            // a namespace hierarchy (as in `@external "jquery.fn"`)
            // TODO: we should probably be doing this for other types of symbols, here or elsewhere;
            // see jsdoc3/jsdoc#396
            doclet.name = doclet.name.replace(/^"([\s\S]+)"$/g, '$1');
            break;

        default:
            // ignore
            break;
    }

    if (!category) {
        logger.debug('Not tracking doclet with unknown kind %s. Name: %s, longname: %s',
            doclet.kind, doclet.name, doclet.longname);
    }
    else {
        this.symbols.add(doclet, category);
        this._trackByCategory(doclet, category);
    }

    this._trackListeners(doclet);

    return this;
};

DocletHelper.prototype.addDoclets = function addDoclets() {
    var doclet;
    var i;
    var l;

    var doclets = this.data().get();

    for (i = 0, l = doclets.length; i < l; i++) {
        this.addDoclet(doclets[i]);
    }

    this.findShortPaths()
        .resolveModuleExports()
        .addListeners();
    // TODO: consider moving this if we're not going to attach the doclets
    this.navTree = helper.longnamesToTree(this.getOutputLongnames());

    for (i = 0, l = doclets.length; i < l; i++) {
        doclet = doclets[i];

        this.registerLink(doclet)
            .addShortPath(doclet)
            .addId(doclet);
    }

    return this;
};

DocletHelper.prototype.addDoclet = function addDoclet(doclet) {
    this._categorize(doclet)
        .processExamples(doclet)
        .processSee(doclet)
        .addSourcePath(doclet)
        .addAncestors(doclet);

    return this;
};

DocletHelper.prototype.registerLink = function registerLink(doclet) {
    var url = helper.createLink(doclet);
    helper.registerLink(doclet.longname, url);

    return this;
};

DocletHelper.prototype.processExamples = function processExamples(doclet) {
    if (doclet.examples) {
        doclet.examples = doclet.examples.map(function(example) {
            var caption, code;

            // TODO: ought to happen in JSDoc proper
            if (example.match(/^\s*<caption>([\s\S]+?)<\/caption>(?:\s*[\n\r])([\s\S]+)$/i)) {
                caption = RegExp.$1;
                code = RegExp.$2;
            }

            return {
                caption: caption || '',
                code: code || example
            };
        });
    }

    return this;
};

DocletHelper.prototype.processSee = function processSee(doclet) {
    var url;

    if (doclet.see) {
        // support `@see #methodName` as a link to methodName within the current file
        doclet.see = doclet.see.map(function(see) {
            if (/^#\S+/.test(see)) {
                see = helper.linkto(doclet.longname, null, null, see.replace(/^#/, ''));
            }

            return see;
        });
    }

    return this;
};

DocletHelper.prototype.addAncestors = function addAncestors(doclet) {
    // TODO: this appears to be the only place where we use this.data; can we get rid of it?
    doclet.ancestors = helper.getAncestors(this.data, doclet);
};

DocletHelper.prototype.addId = function addId(doclet) {
    var id;

    var url = helper.longnameToUrl[doclet.longname];

    if (url.indexOf('#') !== -1) {
        id = helper.longnameToUrl[doclet.longname].split(/#/).pop();
    }
    else {
        id = doclet.name;
    }

    if (id) {
        doclet.id = helper.getUniqueId(url, id);
    }

    return this;
};

function getPathFromMeta(meta) {
    // TODO: why 'null' as a string?
    return meta.path && meta.path !== 'null' ?
        path.join(meta.path, meta.filename) :
        meta.filename;
}

DocletHelper.prototype.addSourcePath = function addSourcePath(doclet) {
    var sourcePath;

    if (doclet.meta) {
        sourcePath = getPathFromMeta(doclet.meta);
        this.shortPaths[sourcePath] = null;

        if (this._sourcePaths.indexOf(sourcePath) === -1) {
            this._sourcePaths.push(sourcePath);
        }
    }

    return this;
};

function lacksProperty(obj, key, targetValue) {
    return !hasOwnProp.call(obj, key) && targetValue !== undefined;
}

/**
 * For classes or functions with the same name as modules (which indicates that the module exports
 * only that class or function), attach the classes or functions to the `exports` property of the
 * appropriate module doclets. The name of each class or function is also updated for display
 * purposes. This function mutates the original arrays.
 *
 * @private
 * @returns {this}
 */
DocletHelper.prototype.resolveModuleExports = function resolveModuleExports() {
    var moduleExports = {};
    var modules = this.symbols.get(CATEGORIES.MODULES);

    // build a lookup table
    // TODO: should do this as we gather doclets
    this.moduleExports.forEach(function(exported) {
        moduleExports[exported.longname] = exported;
    });

    if (modules) {
        modules = modules.map(function(moduleDoclet) {
            if (hasOwnProp.call(moduleExports, module.longname)) {
                moduleDoclet.exports = moduleExports[module.longname];
                // TODO: get rid of this, or make it configurable and move to template file
                moduleDoclet.exports.name = moduleDoclet.exports.name
                    .replace('module:', 'require("') + '")';
            }
        });
    }

    this.moduleExports = [];

    return this;
};

DocletHelper.prototype.addListeners = function addListeners() {
    var events = this.symbols.get(CATEGORIES.EVENTS);
    var self = this;

    events.forEach(function(eventDoclet) {
        var listenerDoclets;

        var listeners = self.listeners[eventDoclet.longname];
        if (listeners) {
            listenerDoclets = listeners.get(CATEGORIES.LISTENERS);
            if (listenerDoclets && listenerDoclets.length) {
                eventDoclet.listeners = eventDoclet.listeners || [];
                listenerDoclets.forEach(function(listenerDoclet) {
                    eventDoclet.listeners.push(listenerDoclet.longname);
                });
            }
        }
    });

    return this;
};

DocletHelper.prototype.findShortPaths = function findShortPaths() {
    var commonPrefix;

    var self = this;

    if (this._sourcePaths.length) {
        commonPrefix = path.commonPrefix(this._sourcePaths);
        this._sourcePaths.forEach(function(filepath) {
            self.shortPaths[filepath] = filepath.replace(commonPrefix, '')
                // always use forward slashes
                .replace(/\\/g, '/');
        });
    }

    return this;
};

DocletHelper.prototype.addShortPath = function addShortPath(doclet) {
    var filepath;

    if (doclet.meta) {
        filepath = getPathFromMeta(doclet.meta);
        if (filepath && hasOwnProp.call(this.shortPaths, filepath)) {
            doclet.meta.shortpath = this.shortPaths[filepath];
        }
    }

    return this;
};

DocletHelper.prototype.getOutputLongnames = function getOutputLongnames() {
    return Object.keys(this.needsFile);
};

DocletHelper.prototype.getPackage = function getPackage() {
    return this.symbols.get(CATEGORIES.PACKAGES)[0];
};

var Template = exports.Template = function Template(templatePath) {
    this.path = templatePath;
    this.swig = null;
    this.views = {};

    this.init();
};

/**
 * Initialize the template engine with required configuration values.
 *
 * @returns {this}
 */
Template.prototype.init = function init() {
    // TODO: allow users to add helpers/filters/tags
    var swigHelpers = require(path.join(__dirname, 'helpers'));
    var swigFilters = require(path.join(__dirname, 'filters'));
    var swigLoader = require(path.join(__dirname, 'loader'));
    var swigTags = require(path.join(__dirname, 'tags'));

    // define local functions that templates can use, and create a Swig instance with those locals
    var self = this;
    var locals = {
        CATEGORIES: CATEGORIES,
        hasOwnProp: function hasOwnProp() {
            var args = Array.prototype.slice.call(arguments, 0);
            var localSelf = args.shift();

            return Object.prototype.hasOwnProperty.apply(localSelf, args);
        },
        linkto: helper.linkto,
        log: logger.debug
    };

    Object.keys(swigHelpers).forEach(function(helperMethod) {
        locals[helperMethod] = swigHelpers[helperMethod];
    });

    this.swig = new Swig({
        locals: locals,
        loader: swigLoader()
    });

    // define the filters that templates can use
    Object.keys(swigFilters).forEach(function(filter) {
        self.swig.setFilter(filter, swigFilters[filter]);
    });

    // define the extra tags that templates can use
    Object.keys(swigTags).forEach(function(tag) {
        self.swig.setTag(tag, swigTags[tag].parse, swigTags[tag].compile, swigTags[tag].ends,
            swigTags[tag].blockLevel);
    });

    // load the base views
    this.addViews(fs.ls(path.join(__dirname, 'views'), 0));

    return this;
};

/**
 * Add one or more views to the template.
 *
 * @param {Array.<string>} views - The paths to the views.
 * @returns {this}
 */
Template.prototype.addViews = function addViews(views) {
    var self = this;

    views.forEach(function(view) {
        logger.debug('Loading the view %s', path.relative(__dirname, view));
        var basename = path.basename(view);
        var name = basename.replace(path.extname(basename), '');

        self.views[name] = self.swig.compileFile(view);
    });

    return this;
};

Template.prototype.render = function render(viewName, data, options) {
    var beautifyOptions;
    var rendered;

    if (!hasOwnProp.call(this.views, viewName)) {
        logger.fatal('Cannot render output with unknown view %s', viewName);
        return '';
    }

    options = options || {};
    rendered = this.views[viewName](data);

    // TODO: also need to normalize whitespace in tags where that's okay
    if (options.beautify !== false) {
        /*eslint camelcase:0 */
        beautifyOptions = {
            indent_size: 2,
            // js-beautify ignores the value 0 because it's falsy
            max_preserve_newlines: 0.1
        };
        rendered = beautify(rendered, beautifyOptions);
    }

    return rendered;
};

var PublishJob = exports.PublishJob = function PublishJob(template, options) {
    this.config = global.env.conf.templates || {};
    this.templateConfig = this.config[CONFIG_KEY] || {};

    this.options = options;
    this.destination = this.options.destination;
    this.package = null;
    this.template = template;
    this.renderOptions = {
        beautify: this.templateConfig.beautify
    };

    // TODO: does JSDoc set this automatically? if not, it should...
    this.options.encoding = this.options.encoding || 'utf8';

    // claim some special filenames in advance
    // don't register `index` as a link; it's also a valid longname
    // TODO: clarify that comment. also, should we stop registering `global`, too?
    this.indexUrl = helper.getUniqueFilename('index');
    this.globalUrl = helper.getUniqueFilename('global');
    helper.registerLink('global', this.globalUrl);
};

PublishJob.prototype.setPackage = function setPackage(packageDoclet) {
    this.package = packageDoclet;

    return this;
};

PublishJob.prototype.copyStaticFiles = function copyStaticFiles() {
    var staticFiles;
    var staticFilter;
    var staticPaths;
    var staticScanner;

    var destination = this.destination;
    var RECURSE_DEPTH = 10;
    var staticPath = path.join(this.template.path, 'static');

    function copyStaticFile(filepath) {
        var fromDir = fs.toDir(filepath);
        var toDir = fs.toDir(filepath.replace(staticPath + path.sep, destination));

        fs.mkPath(toDir);
        logger.debug('Copying static file %s to %s', path.relative(__dirname, filepath), toDir);
        fs.copyFileSync(filepath, toDir);
    }

    // copy the template's static files
    fs.ls(staticPath, RECURSE_DEPTH).forEach(copyStaticFile);

    // copy user-specified static files
    if (this.templateConfig.staticFiles) {
        staticPaths = this.templateConfig.staticFiles.paths || [];
        staticFilter = new Filter(this.templateConfig.staticFiles);
        staticScanner = new Scanner();

        staticPaths.forEach(function(filepath) {
            var extraFiles = staticScanner.scan([filepath], RECURSE_DEPTH, staticFilter);

            extraFiles.forEach(copyStaticFile);
        });
    }

    return this;
};

PublishJob.prototype.createOutputDirectory = function createOutputDirectory() {
    logger.debug('Creating the output directory %s', this.destination);
    fs.mkPath(this.destination);

    return this;
};

PublishJob.prototype.render = function render(viewName, data, options) {
    var opts = _.defaults(options, this.renderOptions);

    return this.template.render(viewName, data, opts);
};

// options: resolveLinks, url
// data: whatever the template expects
// TODO: enum for viewName?
PublishJob.prototype.generate = function generate(viewName, data, url, options) {
    var output;
    var outputPath = path.join(this.destination, url);

    data.package = data.package || this.package;

    options = options ? _.clone(options) : {};
    // don't try to beautify non-HTML files
    if (path.extname(url) !== '.html') {
        options.beautify = false;
    }

    logger.debug('Rendering template output for %s with view %s', url, viewName);
    output = this.render(viewName, data, options);

    // TODO: we should be doing this where necessary within the templates
    if (options.resolveLinks) {
        output = helper.resolveLinks(output);
    }

    try {
        fs.writeFileSync(outputPath, output, 'utf8');
    }
    catch (e) {
        logger.error('Unable to save the output file %s: %s', outputPath, e.message);
    }

    return this;
};

PublishJob.prototype.generateTocData = function generateTocData(navTree) {
    var targets = [];
    var tocData = [];

    function addItems(data) {
        Object.keys(data).sort().forEach(function(key) {
            var item = data[key];
            var tocEntry = {
                // remove leading namespaces from the label
                label: helper.linkto(item.longname, item.name.replace(/^[a-zA-Z]+:/, '')),
                id: item.longname,
                children: []
            };

            if (!targets.length) {
                tocData.push(tocEntry);
            } else {
                targets[targets.length - 1].children.push(tocEntry);
            }

            targets.push(tocEntry);
            addItems(item.children);
            targets.pop();
        });
    }

    logger.debug('Generating the JS file for the table of contents');

    addItems(navTree);

    // TODO: generate() should handle this automatically
    fs.mkPath(path.join(this.destination, 'scripts'));
    return this.generate('toc', { tocData: tocData }, 'scripts/jsdoc-toc.js');
};

PublishJob.prototype.generateTutorials = function generateTutorials(tutorials) {
    var children = [];
    var self = this;

    while (tutorials.children.length) {
        children = children.concat(tutorials.children);
        tutorials = tutorials.children;
    }

    children.forEach(function(child) {
        var tutorialData = {
            pageTitle: PAGE_TITLES[CATEGORIES.TUTORIALS] + child.title,
            header: child.title,
            content: child.parse(),
            children: child.children
        };
        var url = helper.tutorialToUrl(child.title);

        self.generate('tutorial', tutorialData, url, { resolveLinks: true });
    });

    return this;
};

PublishJob.prototype.generateSourceFiles = function generateSourceFiles(pathMap) {
    var encoding = this.options.encoding;
    var self = this;

    if (this.templateConfig.outputSourceFiles !== false) {
        Object.keys(pathMap).forEach(function(file) {
            var url;

            var data = {
                docs: null,
                pageTitle: PAGE_TITLES[CATEGORIES.SOURCES] + pathMap[file]
            };
            var options = {
                resolveLinks: false
            };

            // links are keyed to the shortened path
            url = helper.getUniqueFilename(pathMap[file]);
            helper.registerLink(pathMap[file], url);

            try {
                logger.debug('Generating pretty-printed source for %s', pathMap[file]);
                data.docs = helper.htmlsafe(fs.readFileSync(file, encoding));
            }
            catch (e) {
                logger.error('Unable to generate output for source file %s: %s', file, e.message);
                return;
            }

            self.generate('source', data, url, options);
        });
    } else {
        logger.debug('Pretty-printed source files are disabled; not generating them');
    }

    return this;
};

PublishJob.prototype.generateGlobals = function generateGlobals(doclets) {
    var data;
    var options;

    if (doclets && doclets.hasDoclets()) {
        logger.debug('Generating globals page as %s', this.globalUrl);
        data = {
            members: doclets,
            pageTitle: PAGE_TITLES[CATEGORIES.GLOBALS]
        };
        options = {
            resolveLinks: true
        };

        this.generate('globals', data, this.globalUrl, options);
    } else {
        logger.debug('Not generating a globals page because no globals were found');
    }

    return this;
};

// TODO: this is not at all what we want to put in the index...
PublishJob.prototype.generateIndex = function generateIndex(packages, readme) {
    var data;

    packages = packages || [];
    data = (readme ? packages.concat({readme: readme}) : packages.slice(0));

    logger.debug('Generating index page as %s', this.indexUrl);
    this.generate('index', data, this.indexUrl);

    return this;
};

// TODO: redo to use longname/memberof lookup tables!
PublishJob.prototype.generateByLongname = function generateByLongname(longname, doclets, members) {
    var category;
    var self = this;

    doclets = doclets || {};

    // don't generate pages for package info
    // TODO: improve upon this hack
    if (longname.indexOf('package:') === 0) {
        return this;
    }

    Object.keys(doclets).forEach(function(category) {
        var data;
        var url;

        // Don't generate output if there are no doclets, or if the current category is not one that
        // gets its own output page
        if (!doclets[category].length || OUTPUT_FILE_CATEGORIES.indexOf(category) === -1) {
            return;
        }

        url = helper.longnameToUrl[longname];

        data = {
            docs: doclets[category],
            members: members || {},
            // TODO: may be able to remove here
            pageTitle: PAGE_TITLES[category] + name.shorten(longname).name
        };

        self.generate('symbol', data, url, { resolveLinks: true });
    });

    return this;
};

/**
    @param {TAFFY} data See <http://taffydb.com/>.
    @param {object} opts
    @param {Tutorial} tutorials
 */
exports.publish = function(data, opts, tutorials) {
    var docletHelper = new DocletHelper(data);
    var globals = docletHelper.globals;
    var symbols = docletHelper.symbols;
    var template = new Template(opts.template, docletHelper);
    var job = new PublishJob(template, opts);

    // set up tutorials
    // TODO: why does templateHelper need to be involved?
    helper.setTutorials(tutorials);

    // TODO: seems like this should be where we pass in `data`
    docletHelper.addDoclets();

    job.setPackage(docletHelper.getPackage());

    // create the output directory so we can start generating files
    job.createOutputDirectory()
        // then generate the source files so we can link to them
        .generateSourceFiles(docletHelper.shortPaths);

    // generate globals page if necessary
    job.generateGlobals(globals);

    // generate index page
    // TODO: method params will need to change
    job.generateIndex(symbols.get(CATEGORIES.PACKAGES), opts.readme);

    // generate the rest of the output files (excluding tutorials)
    docletHelper.getOutputLongnames().forEach(function(longname) {
        job.generateByLongname(longname, docletHelper.longname[longname],
            docletHelper.memberof[longname]);
    });

    // finally, generate the TOC data and tutorials, and copy static files to the output directory
    job.generateTutorials(tutorials)
        .generateTocData(docletHelper.navTree)
        .copyStaticFiles();
};
