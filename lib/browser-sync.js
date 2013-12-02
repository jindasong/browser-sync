var portScanner = require('portscanner');
var gaze = require('gaze');
var _ = require("lodash");
var fs = require("fs");
var filePath = require("path");
var connect = require("connect");
var http = require("http");
var UAParser = require('ua-parser-js');
var messages = require('./messages');
var loadSnippet = require('./loadSnippet');
var devIp = require('dev-ip');
var proxy = require('./dev-proxy');
var httpProxy = require('http-proxy');

var parser = new UAParser();
var options;

var scriptData = fs.readFileSync(__dirname + messages.clientScript, "UTF-8");

var browserSync = function () {};

var io;

browserSync.prototype = {
    options: {
        injectFileTypes: ['css', 'png', 'jpg', 'svg', 'gif']
    },
    /**
     * Files patterns
     * @param files
     * @param options
     */
    init: function (files, options) {

        this.userOptions = options;

        var _this = this, io, handles, server, watcher;

        this.getPorts(3, function (ports) {

            // setup Socket.io
            io = _this.setupSocket(ports);

            // Set up event callbacks
            handles = _this.handleSocketConnection(_this.callbacks, options, _this.handleClientSocketEvent);

            // launch the server
            server = _this.launchServer(_this.getHostIp(options), ports, options);

            // Watch files
            watcher = _this.watchFiles(files, io, _this.changeFile, options);

        }, options);
    },
    /**
     * Get two available Ports
     * @param {number} limit
     * @param {function} callback
     * @param options
     */
    getPorts: function (limit, callback, options) {

        var ports = [];

        var lastFound = 2999;

        // get a port (async)
        var getPort = function () {
            portScanner.findAPortNotInUse(lastFound + 1, 4000, 'localhost', function (error, port) {
                ports.push(port);
                lastFound = port;
                runAgain();
            });
        };

        // run again if number of ports not reached
        var runAgain = function () {
            if (ports.length < limit) {
                getPort();
            } else {
                return callback(ports);
            }
            return false;
        };

        // Get the first port
        getPort();

    },
    /**
     * Set up the socket.io server
     * @param {Array} ports
     * @param {object} userOptions
     * @returns {Socket}
     */
    setupSocket: function (ports) {

        io = require('socket.io').listen(ports[0]);
        io.set('log level', 0);

        return io;
    },
    /**
     * Things to do when a client connects
     * @param {Array} events
     * @param {object} userOptions
     * @param {function} handle
     */
    handleSocketConnection: function (events, userOptions, handle) {

        var _this = this;
        var ua;

        io.sockets.on("connection", function (client) {

            // set ghostmode callbacks
            if (userOptions.ghostMode) {
                for (var i = 0, n = events.length; i < n; i += 1) {
                    handle(client, events[i], userOptions, _this);
                }
            }

            client.emit("connection", userOptions);

            ua = client.handshake.headers['user-agent'];

            _this.logConnection(ua, userOptions);
        });
    },
    /**
     * Add a client event & it's callback
     * @param {object} client
     * @param {string} event
     * @param {object} userOptions
     */
    handleClientSocketEvent: function (client, event, userOptions, _this) {
        client.on(event.name, function (data) {
            event.callback(client, data, _this);
        });
    },
    /**
     * Kill the current socket IO server
     */
    killSocket: function () {
        return io.server.close();
    },
    /**
     * Log a successful client connection
     * @param {object} ua
     * @param {object} userOptions
     */
    logConnection: function (ua, userOptions) {
        this.log(messages.connection(parser.setUA(ua).getBrowser()), userOptions, true);
    },
    /**
     * ghostMode Callbacks (responses to client events)
     */
    callbacks: [
        { name: "scroll", callback: function (client, data) {
            client.broadcast.emit("scroll:update", { position: data.pos, ghostId: data.ghostId, url: data.url});
        }},
        {
            name: "location",
            callback: function (client, data, context) {
                context.log(messages.location(data.url), context.userOptions, false);
                client.broadcast.emit("location:update", { url: data.url });
            }
        },
        {
            name: "input:type",
            callback: function (client, data) {
                client.broadcast.emit("input:update", { id: data.id, value: data.value });
            }
        },
        {
            name: "input:select",
            callback: function (client, data) {
                client.broadcast.emit("input:update", { id: data.id, value: data.value });
            }
        },
        {
            name: "input:radio",
            callback: function (client, data) {
                client.broadcast.emit("input:update:radio", { id: data.id, value: data.value });
            }
        },
        {
            name: "input:checkbox",
            callback: function (client, data) {
                client.broadcast.emit("input:update:checkbox", { id: data.id, checked: data.checked });
            }
        },
        {
            name: "form:submit",
            callback: function (client, data) {
                client.broadcast.emit("form:submit", { id: data.id });
            }
        },
        {
            name: "form:reset",
            callback: function (client, data) {
                client.broadcast.emit("form:submit", { id: data.id });
            }
        }
    ],
    /**
     * Helper to try to retrieve the correct external IP for host
     * Defaults to localhost if no network ip's are accessible.
     * @param {object} options
     * @returns {string} - the IP address
     */
    getHostIp: function (options) {

        var externalIp = "0.0.0.0"; // default

        if (options) {
            if (options.host) {
                return options.host;
            }
            if (options.detect === false) {
                return externalIp;
            }
        }

        return devIp.getIp() || externalIp;
    },
    /**
     * Take the path provided in options & transform into CWD for serving files
     * @param {string} baseDir
     * @returns {string}
     */
    getBaseDir: function (baseDir) {

        var suffix = "";

        if (!baseDir || baseDir === "./" || baseDir === "/" || baseDir === ".") {
            return process.cwd();
        } else {
            if (baseDir[0] === "/") {
                suffix = baseDir;
            } else {
                if (baseDir[0] === "." && baseDir[1] === "/") {
                    suffix = baseDir.replace(".", "");
                } else {
                    suffix = "/" + baseDir;
                }
            }
        }

        return process.cwd() + suffix;
    },
    /**
     * Expose messages for tests
     * @returns {*|exports}
     */
    getMessages: function () {
        return messages;
    },
    /**
     * Log a message to the console
     * @param {string} msg
     * @param {object} options
     * @param {boolean} override
     * @returns {boolean}
     */
    log: function (msg, options, override) {

        if (!options.debugInfo && !override) {
            return false;
        }

        return console.log(msg);
    },
    /**
     * @param {string} path
     * @param {socket} io
     * @param {object} options
     * @param _this - context
     * @returns {{assetFileName: string}}
     */
    changeFile: function (path, io, options, _this) {

        var fileName = filePath.basename(path);
        var fileExtension = _this.getFileExtension(path);

        var data = {
            assetFileName: fileName,
            fileExtension: fileExtension
        };

        var message = "inject";

        // RELOAD page
        if (!_.contains(options.injectFileTypes, fileExtension)) {
            data.url = path;
            message = "reload";
        }

        // emit the event through socket
        io.sockets.emit("reload", data);

        // log the message to the console
        _this.log(messages.fileChanged(path), options, false);
        _this.log(messages.browser[message](), options, false);

        return data;
    },
    /**
     * Launch the server for serving the client JS plus static files
     * @param {String} host
     * @param {Array} ports
     * @param {Object} options
     * @returns {*|http.Server}
     */
    launchServer: function (host, ports, options) {

        var modifySnippet = function (req, res) {
            res.setHeader("Content-Type", "text/javascript");
            res.end(messages.socketConnector(host, ports[0]) + scriptData);
        };

        var app;

        if (!options.server) {
            app = connect().use(messages.clientScript, modifySnippet);
        }

        if (options.proxy) {
            this.createProxy(host, ports, options);
        } else {

            // serve static files
            loadSnippet.setVars(host, ports[0], ports[1]);

            var baseDir = options.server.baseDir || "./";
            var index = options.server.index || "index.html";

            app = connect()
                    .use(messages.clientScript, modifySnippet)
                    .use(loadSnippet.middleWare)
                    .use(connect.static(filePath.resolve(baseDir), {index: index}));
        }

        var server = http.createServer(app).listen(ports[1]);
        var msg;

        if (options.server) {
            msg = messages.initServer(host, ports[1], this.getBaseDir(options.server.baseDir || "./"), options);
            this.openBrowser(host, ports[1], options);
        } else {
            msg = messages.init(host, ports[0], ports[1]);
        }

        this.log(msg, options, true);

        return server;
    },
    createProxy: function (host, ports, options) {

        var getSnippet = function (hostIp, socketIoPort, scriptPort) {
            return messages.scriptTags(hostIp, socketIoPort, scriptPort, false);
        };

        //
        // Set up a proxy
        //
        httpProxy.createServer(function (req, res, proxy) {

            //
            // Put your custom server logic here
            //
            var next = function () {
                proxy.proxyRequest(req, res, {
                    host: options.proxy.host,
                    port: options.proxy.port
                });
            };

            var write = res.write;

            res.write = function (string, encoding) {

                var body = string instanceof Buffer ? string.toString() : string;

                // Not html
                if (!/<body[^>]*>/.test(body)) {
                    return write.call(res, string, encoding);
                }

                // Try to inject script
                body = body.replace(/<\/body>/, function (w) {
                    return messages.scriptTags(host, ports[0], ports[1], false) + w;
                });

                if (string instanceof Buffer) {
                    string = new Buffer(body);
                } else {
                    string = body;
                }

                if (!this.headerSent) {
                    this.setHeader('content-length', Buffer.byteLength(body));
                    this._implicitHeader();
                }

                write.call(res, string, encoding);
            };

            next();

        }).listen(ports[2]);

    },
    /**
     * Open the page in browser
     * @param host
     * @param port
     * @param options
     */
    openBrowser: function (host, port, options) {
        if (options.open) {
            var open = require("open");
            open("http://" + host + ":" + port);
        }
    },
    /**
     * Proxy for chokidar watching files
     * @param {Array|string} files
     * @param {object} io
     * @param {function} callback
     * @param options
     */
    watchFiles: function (files, io, callback, options) {

        var _this = this, log = this.log;

        gaze(files, function(err, watcher) {

            var key = Object.keys(this.watched())[0];

            if (key) {
                log(messages.fileWatching(watcher._patterns), options, true);
            } else {
                log(messages.fileWatching(false), options, true);
            }

            // On file changed
            this.on('changed', function(filepath) {
                callback(filepath, io, options, _this);
            });

        });
    },
    getFileExtension: function (path) {
        return filePath.extname(path).replace(".", "");
    }
};

module.exports = browserSync;