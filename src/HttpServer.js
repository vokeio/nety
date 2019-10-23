'use strict';

const Os = require('os');
const Path = require('path');
const Util = require('util');
const Http = require('http');
const Https = require('https');
const Http2 = require('http2');
const Url = require('url').URL;
const Stream = require('stream');
const Querystring = require('querystring');

const Mime = require('./mime.js');
const Status = require('./status.js');

module.exports = class HttpServer {

    constructor ( options = {} ) {
        this.options = { ...options };

        this.xss = true;
        this.hsts = true;
        this.xframe = true;
        this.xcontent = true;
        this.xdownload = true;

        this.mime = Mime;
        this.status = Status;

        this.family = null;
        this.address = null;
        this.port = this.options.port || 0;
        this.debug = this.options.debug || false;
        this.plugins = this.options.plugins || [];
        this.host = this.options.host || Os.hostname() || 'localhost';

        this.version = this.options.version || 1;
        this.secure = this.options.secure || false;
        this.charset = this.options.charset || 'charset=utf8';
        this.contentType = this.options.contentType || 'text/plain';

        delete this.options.port;
        delete this.options.host;
        delete this.options.debug;
        delete this.options.secure;
        delete this.options.charset;
        delete this.options.version;
        delete this.options.plugins;
        delete this.options.contentType;

        if (this.version === 1 && this.secure === false) this.listener = Http.createServer(this.options, this.handler.bind(this));
        else if (this.version === 1 && this.secure === true) this.listener = Https.createServer(this.options, this.handler.bind(this));
        else if (this.version === 2 && this.secure === false) this.listener = Http2.createServer(this.options, this.handler.bind(this));
        else if (this.version === 2 && this.secure === true) this.listener = Http2.createSecureServer(this.options, this.handler.bind(this));

    }

    head () {
        const head = {};

        if (this.hsts === true) {
            head['strict-transport-security'] = 'max-age=31536000; includeSubDomains; preload';
        } else if (typeof this.hsts === 'string') {
            head['strict-transport-security'] = this.hsts;
        }

        if (this.xframe === true) {
            head['x-frame-options'] = 'SAMEORIGIN';
        } else if (typeof this.xframe === 'string') {
            head['x-frame-options'] = this.xframe;
        }

        if (this.xss === true) {
            head['x-xss-protection'] = '1; mode=block';
        } else if (typeof this.xss === 'string') {
            head['x-xss-protection'] = this.xss;
        }

        if (this.xdownload === true) {
            head['x-download-options'] = 'noopen';
        } else if (typeof this.xdownload === 'string') {
            head['x-download-options'] = this.xdownload;
        }

        if (this.xcontent === true) {
            head['x-content-type-options'] = 'nosniff';
        } else if (typeof this.xcontent === 'string') {
            head['x-content-type-options'] = this.xcontent;
        }

        return head;
    }

    extension (data) {
        data = data || '';
        return data.includes('.') ? Path.extname(data).slice(1) : 'txt';
    }

    end (context) {

        if (context.head === null || context.head === undefined) context.head = {};
        if (context.code === null || context.code === undefined) context.code = 200;
        if (context.message === null || context.message !== undefined) context.message = this.status[ context.code ];
        if (context.body === null || context.body === undefined) context.body = { code: context.code, message: context.message };

        if (context.body instanceof Stream.Readable) {
            const extension = this.extension(context.body.path);
            const mime = context.instance.mime[extension];

            context.head['content-type'] = `${mime};${this.charset}`;
            context.response.writeHead(context.code, context.head);
            context.body.pipe(context.response);

            return;
        }

        if (typeof context.body === 'object') {
            const mime = context.instance.mime['json'];
            context.head['content-type'] = `${mime};${this.charset}`;
            context.body = JSON.stringify(context.body);
        }

        if (!context.head['content-type']) context.head['content-type'] = `${this.contentType};${this.charset}`;
        if (!context.head['content-length']) context.head['content-length'] = Buffer.byteLength(context.body);

        context.response.writeHead(context.code, context.head);
        context.response.end(context.body);
    }

    async handler (request, response) {

        const context = { code: null, body: null, message: null, head: this.head() };
        const end = this.end.bind(this, context);
        const headers = request.headers;

        const path = headers[':path'] || request.url;
        const method = (headers[':method'] || request.method).toLowerCase();
        const authority = (headers[':authority'] || headers['host']).toLowerCase();
        const scheme = headers[':scheme'] || this.secure ? 'https' : 'http';
        const url = new Url(`${scheme}://${authority}${path}`);

        // const cookies = {};

        Object.defineProperties(context, {
            // cookies: { enumerable: true, value: cookies },
            end: { enumerable: true, value: end },
            url: { enumerable: true, value: url },
            method: { enumerable: true, value: method },
            instance: { enumerable: true, value: this },
            headers: { enumerable: true, value: headers },
            request: { enumerable: true, value: request },
            response: { enumerable: true, value: response },
            listener: { enumerable: true, value: this },
        });

        try {
            const plugins = this.plugins;

            for (const plugin of plugins) {
                if (context.response.closed || context.response.aborted || context.response.destroyed || context.response.writableEnded) {
                    break;
                } else {
                    await plugin.handler.call(plugin, context);
                }
            }

            if (!context.response.closed && !context.response.aborted && !context.response.destroyed && !context.response.writableEnded) {
                context.end();
            }

        } catch (error) {
            context.code = 500;
            context.message = this.debug ? error.message : 'internal server error';
            context.body = { code: context.code, message: context.message };
            context.end();
            console.error(error);
        }

    }

    async plugin (plugin) {
        const { handler } = typeof plugin === 'function' ? { handler: plugin } : plugin;
        if (!handler) throw new Error('Nety.plugin - handler required');
        this.plugins.push({ handler, plugin });
    }

    async open () {
        return new Promise(resolve => {
            this.listener.listen(this.port, this.host, () => {
                const info = this.listener.address();
                this.port = info.port;
                this.family = info.family;
                this.address = info.address;
                this.host = this.host || info.address;
                resolve();
            });
        });
    }

    async close () {
        return new Promise(resolve => {
            this.listener.close(() => {
                resolve();
            });
        });
    }

}
