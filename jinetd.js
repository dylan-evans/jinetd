var fs = require('fs');
var net = require('net');
var util = require('util');
var events = require('events');
var spawn = require('child_process').spawn;

function Service(name, config) {
    this.name = name;
    this.port = config.port;
    this.command = config.command;
    this.args = config.args || [];
    this.limit = config.limit || 1000;
    this.count = 0;
    this.workers = [];

    this.active = function() {
        return (this.server !== undefined && this.server !== null)
                ? true : false;
    };

    this.start = function() {
        var service = this;

        if(this.active()) {
            return;
        }
        service.server = net.createServer({allowHalfOpen: true}, function(c) {
            var child = spawn(service.command, service.args,
                { stdio: 'pipe' } 
            );

            if(!child) {
                utils.error("Failed exec on service " + service.name);
                c.end();
                return;
            }
            service.workers.push(child);
            console.log("Started child : " + child.pid);

            // Passing the socket to stdio doesn't seem to work
            c.pipe(child.stdin);
            child.stdout.pipe(c);
            child.stderr.pipe(c);

            child.on('exit', function(code, signal) {
                var new_workers = [];
                for(var i = 0; i < service.workers.length; i++) {
                    if(service.workers[i] !== child) {
                        new_workers.push(service.workers[i]);
                    }
                }
                service.workers = new_workers;
                console.log("Process " + child.pid + " exited with status " +
                    code + " from a signal " + signal);
            });

            child.on('close', function() {
                child.kill('SIGHUP');
            });
        });
        this.server.maxConnections = this.limit;
        this.server.listen(this.port);
        util.log("Started service " + name + " on port " + this.port);
    };

    this.stop = function() {
        this.server.close();
        util.log("Stopping service " + this.name + " on port " + this.port);
    };

    this.restart = function() {
        this.server.close(function() {
            service.start();
        });
    };

    this.kill = function(cb) {
        var service = this;
        if(cb !== undefined) {
            this.once('killed', cb);
        }
        //Perform extended INT, TERM, KILL routine then raise 'killed'
        this.workers.forEach(function(child) {
            child.kill('HUP');
        });
        setTimeout(function() {
            if(service.workers.length === 0) {
                service.emit('killed');
                return;
            }
            service.workers.forEach(function(child) {
                child.kill('TERM');
            });
            setTimeout(function() {
                if(service.workers.length === 0) {
                    service.emit('killed');
                    return;
                }
                service.workers.forEach(function(child) {
                    child.kill('KILL');
                });
                service.emit('killed');
            }, 1000);
        }, 500);
    };
}
Service.prototype = events.EventEmitter;


function Config(base) {
    this.service_table = {};
    this.port_table = {};

    this.get_service = function(id) {
        return this.service_table[id] || this.port_table[id];
    }
    
    this.merge = function(config, overwrite) {
        // Weirdly overwrite is default
        if(overwrite === undefined || overwrite === null) {
            overwrite = true;
        }
    };

    this.load = function(path) {
        var config = this;
        if(path instanceof Array) {
            path.forEach(this.load);
        } else {
            fs.stat(path, function(err, stat) {
                if(err) {
                    if(err.code === 'ENOENT') return;
                    throw(err);
                }
                if(stat.isDirectory()) {
                    fs.readdir(path, config.load);
                } else if(path.match('\.json$')) {
                    config.loadfile(path);
                }
            });
       }    
    };
    
    this.loadfile = function(filename) {
        var config = this;
        util.log("Loading " + filename);
        fs.readFile(filename, 'utf8',  function(err, data) {
            if(err) throw err;
            var cf = JSON.parse(data);
            if(cf instanceof Array) {
                cf = { service: cf };
            }

            if(cf.include !== undefined) {
                config.load(cf.include);
            }

            for(name in cf.service)
            {
                config.load_service(name, cf.service[name]);
            }
        });
    };

    this.load_service = function(name, scf) {
        var config = this;
        if(scf.action === undefined || scf.action === 'exec') {
            if(scf.port === undefined) {
                throw "Port is required";
            }

            var s = new Service(name, scf);
            config.service_table[name] = s;
            config.port_table[s.port] = s;
            s.start();
        } else if(scf.action === 'redirect') {

        } else {
            util.log("Service '" + name + "' has unknown action: " 
                + scf.action);
        }

    };

    if(base !== undefined) {
        this.loadfile(base);
    }  

}

var options = {
    debug: false,
    verbose: 0,
    log: null
};


// Main section is here
if(process.argv.length > 0) {
    util.log("Starting");
    var conf = [];
    for(var i = 2; i < process.argv.length; i++) {
        var arg = process.argv[i];
        if(arg === '-c') {
            var file = process.argv[++i];
            if(file === undefined) {
                console.log("-c requires an argument");
            } else {
                conf.push(file);
            }
        }
    }
    
    var dmn = new Config();
    if(conf.length === 0) {
        dmn.loadfile('config.json');
    } else {
        conf.forEach(function(item) {
            dmn.load(item);
        });
    }
} 

