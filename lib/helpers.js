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

var _ = require('underscore');
var fs = require('jsdoc/fs');
var path = require('jsdoc/path');
var stripJsonComments = require('strip-json-comments');
var templateHelper = require('jsdoc/util/templateHelper');
var util = require('util');

var hasOwnProp = Object.prototype.hasOwnProperty;

function addLink(item, linkText) {
    if (linkText) {
        linkText = templateHelper.htmlsafe(linkText);
    }

    return templateHelper.linkto(item, linkText);
}

function linkItems(arr) {
    arr = arr.slice(0);
    arr.forEach(function(item) {
        item = addLink(item);
    });

    return arr;
}

exports.ancestorLinks = function ancestorLinks(doclet, cssClass) {
    var links = [];

    if (doclet.ancestors) {
        doclet.ancestors.forEach(function(ancestor) {
            var linkText = (templateHelper.scopeToPunc[ancestor.scope] || '') + ancestor.name;
            var link = templateHelper.linkto(ancestor.longname, linkText, cssClass);
            links.push(link);
        });
    }

    if (links.length) {
        links[links.length - 1] += (templateHelper.scopeToPunc[doclet.scope] || '');
    }

    return links.join('');
};

// TODO: make this configurable
// TODO: add a class to every single block
var cssClasses = JSON.parse(stripJsonComments(fs.readFileSync(path.join(__dirname,
    '../styles/classmap.json'), 'utf8')));

exports.cssclass = function cssclass() {
    var result = [];
    var keys = _.flatten(Array.prototype.slice.call(arguments));

    keys.forEach(function(key) {
        // if the name is prefixed by `!`, strip the prefix and unconditionally add it
        if (key.indexOf('!') === 0) {
            result.push(key.substr(1));
        }
        // otherwise, only add the name if the user asked for it
        // (a falsy value doesn't count as "asking for it")
        else if (hasOwnProp.call(cssClasses, key) && cssClasses[key]) {
            result.push(key);
        }
    });

    if (!result.length) {
        return '';
    }

    return util.format(' class="%s"', result.join(' '));
};

exports.jsdocVersion = function jsdocVersion() {
    return global.env.version.number;
};

exports.link = function link(input, linkText) {
    if ( Array.isArray(input) ) {
        return linkItems(input);
    }

    return addLink(input, linkText);
};

exports.moveChildren = function moveChildren(items) {
    var parentItem = null;

    items = items.slice(0);

    items.forEach(function(item, i) {
        // TODO: when would this happen? can we remove it?
        if (!item) {
            return;
        }

        if (parentItem && item.name && item.name.indexOf(item.name + '.') === 0) {
            parentItem.children = parentItem.children || [];
            parentItem.children.push(item);
            items[i] = null;
        }
        else {
            parentItem = item;
        }
    });

    return _.compact(items);
};

exports.containsFunctionType = function containsFunctionType(type) {
    var containsFunction = false;

    if (type && type.names && type.names.length) {
        for (var i = 0, l = type.names.length; i < l; i++) {
            if (type.names[i].toLowerCase() === 'function') {
                containsFunction = true;
                break;
            }
        }
    }

    return containsFunction;
};

exports.needsSignature = function needsSignature(doclet) {
    var needsSig = false;

    // function and class definitions always get a signature
    if (doclet.kind === 'function' || doclet.kind === 'class') {
        needsSig = true;
    }
    // typedefs that contain functions get a signature, too
    else if (doclet.kind === 'typedef' && doclet.type && doclet.type.names &&
        doclet.type.names.length) {
        for (var i = 0, l = doclet.type.names.length; i < l; i++) {
            if (doclet.type.names[i].toLowerCase() === 'function') {
                needsSig = true;
                break;
            }
        }
    }

    return needsSig;
};

exports.formatParams = function formatParams(params) {
    var formatted = '';

    params.filter(function(param) {
        return param.name && param.name.indexOf('.') === -1;
    }).forEach(function (param, i) {
        var formattedParam = param.name || '';

        if (param.variable) {
            formattedParam = '...' + formattedParam;
        }

        if (i > 0) {
            formattedParam = ', ' + formattedParam;
        }

        if (param.optional) {
            formattedParam = '[' + formattedParam + ']';
        }

        formatted += formattedParam;
    });

    formatted = '(' + formatted + ')';

    return formatted;
};
