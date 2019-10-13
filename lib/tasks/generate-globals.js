/*
    Copyright 2014-2019 Google LLC

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        https://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
const { CATEGORIES } = require('../enums');
const GenerateFiles = require('./generate-files');
const helper = require('jsdoc/util/templateHelper');
const Ticket = require('../ticket');

module.exports = class GenerateGlobals extends GenerateFiles {
    constructor(opts) {
        super(opts);

        this.url = opts.url;
    }

    run(ctx) {
        let data;
        const globalsDb = ctx.globals;
        const globals = globalsDb.value();
        const template = ctx.template;
        let title;

        if (!globals.length) {
            return Promise.resolve();
        }

        this.url = this.url || helper.longnameToUrl.global;

        title = template.translate(`headings.${CATEGORIES.GLOBALS}`, globals.length);
        data = {
            members: globalsDb.categorize().value(),
            pageCategory: null,
            pageHeading: template.translate(`headings.${CATEGORIES.GLOBALS}`, globals.length),
            pageTitle: template.translate('pageTitleNoCategory', {
                prefix: ctx.pageTitlePrefix,
                title
            }),
            pageTitlePrefix: ctx.pageTitlePrefix
        };

        this.tickets = [
            new Ticket({
                data,
                url: this.url,
                viewName: 'globals'
            })
        ];

        return super.run(ctx);
    }
};
