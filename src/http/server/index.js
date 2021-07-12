'use strict';

const Os = require('os');
// const Util = require('util');
const Http = require('http');
const Https = require('https');
const Http2 = require('http2');
// const Url = require('url').URL;
// const Stream = require('stream');

const Mime = require('../../mime.js');
const Status = require('../../status.js');
const Methods = require('../../methods.js');

const Context = require('./context.js');

const Basic = require('./plugin/basic.js');
const Cache = require('./plugin/cache.js');
const Compress = require('./plugin/compress.js');
const Cookie = require('./plugin/cookie.js');
const Normalize = require('./plugin/normalize.js');
const Payload = require('./plugin/payload.js');
const Preflight = require('./plugin/preflight.js');
const Session = require('./plugin/session.js');
const File = require('./plugin/file.js');

/**
* Class for an Http Server.
*/

class HttpServer {

    get mime () { return Mime; }
    get status () { return Status; }
    get methods () { return Methods; }
    get context () { return Context; }

    /**
    * Create an Http Server.
    * @param {Object} options Options
    * @param {Number} [options.port=0] - Port number
    * @param {Boolean} [options.debug=false] - Debug mode
    * @param {Boolean} [options.host=Os.hostname||'localhost'] - Host name
    */

    constructor (options = {}) {

        this.family = null;
        this.type = options.type;
        this.port = options.port || 0;
        this.encoding = options.encoding;
        this.server = options.server || {};
        this.debug = options.debug || false;
        this.version = options.version || 1;
        this.handles = options.handles || [];
        this.secure = options.secure || false;
        this.host = options.host || Os.hostname() || 'localhost';
        this.address = options.address || options.host || '0.0.0.0';
        this.end = typeof options.end === 'boolean' ? options.end : true;

        this.xss = options.xss || '1; mode=block';
        this.xframe = options.xframe || 'SAMEORIGIN';
        this.xcontent = options.xcontent || 'nosniff';
        this.xdownload = options.xdownload || 'noopen';
        this.hsts = options.hsts || 'max-age=31536000; includeSubDomains; preload';

        if (this.version === 2) this.server.allowHTTP1 = true;
        if (typeof this.secure === 'object') Object.assign(this.server, this.secure);

        if (this.version === 1 && !this.secure) this.listener = Http.createServer(this.server, this.handle.bind(this));
        else if (this.version === 1 && this.secure) this.listener = Https.createServer(this.server, this.handle.bind(this));
        else if (this.version === 2 && !this.secure) this.listener = Http2.createServer(this.server, this.handle.bind(this));
        else if (this.version === 2 && this.secure) this.listener = Http2.createSecureServer(this.server, this.handle.bind(this));

    }

    /**
    * Compares the arguments against the context.
    * If no HTTP-Method is provided then all are accpeted (*).
    * If no Virutal Host is provided then all host headers are accpeted (*).
    * Dyanmic paths are accepted single level use such as /{ANY} /(ANY), or multiple levels such as /{*} /(*).
    * @async
    * @param {Object<String|Array>} - request.host, request.method, request.path
    * @param {Object<String|Array>} - response.host, response.method, response.path
    * @return {Boolean}
    */

    async match (request, response) {

        if (typeof response.method === 'string') response.method = [ response.method ];
        if (typeof response.host === 'string') response.host = [ response.host ];
        if (typeof response.path === 'string') response.path = [ response.path ];

        if (!response.method.includes('*') && !response.method.includes(request.method)) return false;
        if (!response.host.includes('*') && !response.host.includes(request.host)) return false;

        // if (
        //     !response.path.includes('/{*}') &&
        //     !response.path.includes('/(*)') &&
        //     !response.path.includes('/{~}') &&
        //     !response.path.includes('/(~)') &&
        //     !response.path.includes(request.path)
        // ) return false;
        //
        // return true;

        const requestPath = request.path;
        const requestParts = requestPath.split(/\/|-/);

        const responsePaths = response.path;
        for (const responsePath of responsePaths) {

            const responseParts = responsePath.split(/\/|-/);
            const compareLength = responseParts.length;
            const compareParts = [];

            for (let i = 0; i < compareLength; i++) {

                if (
                    responseParts[ i ].startsWith('(') && responseParts[ i ].endsWith(')') ||
                    responseParts[ i ].startsWith('{') && responseParts[ i ].endsWith('}')
                ) {

                    if (
                        responseParts[ i ] === '(~)' || responseParts[ i ] === '(*)' ||
                        responseParts[ i ] === '{~}' || responseParts[ i ] === '{*}'
                    ) {
                        return true;
                    } else {
                        compareParts.push(requestParts[ i ]);
                    }

                } else if (responseParts[ i ] !== requestParts[ i ]) {
                    return false;
                } else {
                    compareParts.push(responseParts[ i ]);
                }

            }

            if (compareParts.join('/') === requestParts.join('/')) {
                return true;
            } else {
                return false;
            }

        }

        return false;
    }

    /**
    * Handle
    * @async
    * @private
    */

    async handle (request, response) {

        if (this.xss) response.setHeader('x-xss-protection', this.xss);
        if (this.xframe) response.setHeader('x-frame-options', this.xframe);
        if (this.hsts) response.setHeader('strict-transport-security', this.hsts);
        if (this.xdownload) response.setHeader('x-download-options', this.xdownload);
        if (this.xcontent) response.setHeader('x-content-type-options', this.xcontent);

        const instance = this;
        const context = new this.context({ request, response, instance });

        try {
            const handles = this.handles;

            for (const handle of handles) {
                if (response.finished) {
                    break;
                } else {
                    const match = await this.match(
                        { method: context.method, host: context.url.hostname, path: context.url.pathname },
                        { method: handle.method, host: handle.host, path: handle.path }
                    );
                    if (!match) continue;
                    const value = await handle.handle.call(handle.self, context);
                    if (handle.name && value) context.set(handle.name, value);
                }
            }

            if (!response.finished && this.end) {
                return context.end();
            }

        } catch (error) {
            const message = this.debug ? error.message : undefined;
            const code = typeof error.code === 'number' ? error.code : 500;

            if (typeof error.code !== 'number' || error.code === 500) {
                console.error(`${context.method} ${context.url.pathname}`);
                console.error(error);
            }

            return context.code(code).end(message);
        }

    }

    /**
    * Adds handles to the server.
    * A single String or multiple Strings must proceed an Array, Function, or Object.
    * Multiple String arguments are accepted with the delimiter of a space, line break, or comma.
    * Valid String arguments are HTTP-Methods, Virtual-Hosts, and paths starting with a forward slash.
    * Dynamic paths, hosts, and methods are accepted. See the context.match method.
    * If no String arguments are provided then the following Array, Function, or Object will use the '* * /{*}' pattern.
    * @async
    * @param {String|Array|Function|Object}
    */

    async add () {
        const methods = this.methods;
        const length = arguments.length;
        let holder = '';

        for (let i = 0; i < length; i++) {
            const argument = arguments[ i ];

            if (argument instanceof Array) {
                for (const data of argument) await this.add(holder, data);
                holder = '';
            } else if (typeof argument === 'string') {
                if (holder) {
                    holder = `${holder},${argument}`;
                } else {
                    holder = `${argument}`;
                }
            } else {
                let self, handle, name;
                const method = [], host = [], path = [];

                if (holder) {
                    const parts = holder.trim().toLowerCase().split(/\s+|,/);

                    for (const part of parts) {
                        if (part === '' || part === ',') {
                            continue;
                        } else if (part.startsWith('/')) {
                            path.push(part);
                        } else if (methods.includes(part)) {
                            method.push(part);
                        } else {
                            host.push(part);
                        }
                    }

                    holder = '';
                }

                if (!host.length) host.push('*');
                if (!path.length) path.push('/{*}');
                if (!method.length) method.push('*');

                if (typeof argument === 'function') {
                    self = argument;
                    handle = argument;
                } else if (typeof argument === 'object') {
                    self = argument;
                    handle = argument.handle;
                } else {
                    throw new Error('invalid handle');
                }

                name = argument.name || argument.constructor.name;
                name = name === 'Function' ? '' : name;
                name = `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

                this.handles.push({ self, handle, name, method, host, path });
            }

        }

    }

    async get () {
        return this.add.apply(this, [ 'get', ...arguments ]);
    }

    async post () {
        return this.add.apply(this, [ 'post', ...arguments ]);
    }

    async put () {
        return this.add.apply(this, [ 'put', ...arguments ]);
    }

    async connect () {
        return this.add.apply(this, [ 'connect', ...arguments ]);
    }

    async delete () {
        return this.add.apply(this, [ 'delete', ...arguments ]);
    }

    async head () {
        return this.add.apply(this, [ 'head', ...arguments ]);
    }

    async options () {
        return this.add.apply(this, [ 'options', ...arguments ]);
    }

    async patch () {
        return this.add.apply(this, [ 'patch', ...arguments ]);
    }

    async trace () {
        return this.add.apply(this, [ 'trace', ...arguments ]);
    }

    /**
    * Starts listening on the port and host.
    * @async
    */

    async open () {
        return new Promise(resolve => {
            this.listener.listen(this.port, this.address, () => {
                const info = this.listener.address();
                this.port = info.port;
                this.family = info.family;
                this.address = info.address;
                resolve();
            });
        });
    }

    /**
    * Stops listening on the port and host.
    * @async
    */

    async close () {
        return new Promise(resolve => {
            this.listener.close(() => {
                resolve();
            });
        });
    }

}

Object.assign(HttpServer, {
    Server: HttpServer,
    Context,
    Basic,
    Cache,
    Compress,
    Cookie,
    File,
    Normalize,
    Payload,
    Preflight,
    Session
});

module.exports = HttpServer;
