#!/usr/bin/env node
'use strict';
var request = require('request');
var async = require('async');
var _ = require('lodash');
var commander = require('commander');
var fs = require('fs');

commander
  .option('--configFile <file>', 'config file (required) containing connection info for nodes')
  .parse(process.argv);

if (!commander.configFile){
  return commander.help();
}

var config = JSON.parse(fs.readFileSync(commander.configFile));

function rpc(node, command, params, callback){
  request.post({
    url: node.protocol + '://' + node.username + ':' + node.password + '@' + node.host + ':' + node.port,
    body: {
      jsonrpc: '1.0', id: '123', 'method': command, params: params || []
    },
    json:true
  }, function (err, response, body) {
    callback(null, (body && body.result) || body);
  });
}

var unionPool = [];
var unionPoolSources = {};

async.map(config, function(node, cb){
  rpc(node, 'getrawmempool', [], function(err, mempool){
    cb(null, mempool);
  });
}, function(err, mempools){
  mempools.forEach(function(mempool, index){
    mempool.forEach(function(tx){
      unionPool.push(tx);
      unionPoolSources[tx] = index;
    });
  });
  unionPool = _.uniq(unionPool);
  async.eachOf(config, function(node, index, cb){
    if (!mempools[index].length){
      return cb();
    }
    var missing = _.difference(unionPool, mempools[index]);
    async.mapSeries(missing, function(txid, cb){
      rpc(config[unionPoolSources[txid]], 'getrawtransaction', [txid], function(err, tx){
        cb(null, tx);
      });
    }, function(err, missing){
      async.eachSeries(missing, function(tx, cb){
        rpc(node, 'sendrawtransaction', [tx], function(err, result){
          console.log(result + ' sent to ' + node.host);
          cb();
        });
      }, function(err){
        cb();
      });
    });
  }, function(err){
    console.log('done');
  });
});