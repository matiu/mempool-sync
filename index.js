#!/usr/bin/env node
'use strict';
var request = require('request');
var async = require('async');
var _ = require('lodash');
var commander = require('commander');
var fs = require('fs');
var ProgressBar = require('progress');

commander
  .option('--configFile <file>', 'config file (required) containing connection info for nodes')
  .parse(process.argv);

if (!commander.configFile){
  return commander.help();
}

var nodes = JSON.parse(fs.readFileSync(commander.configFile));

function rpc(node, command, params, callback){
  request.post({
    url: node.protocol + '://' + node.username + ':' + node.password + '@' + node.host + ':' + node.port,
    body: {
      jsonrpc: '1.0', id: '123', 'method': command, params: params || []
    },
    json:true,
    strictSSL: false
  }, function (err, response, body) {
    if (body && body.error) {
      callback(body.error);
    } else {
      callback(err, (body && body.result) || body);
    }
  });
}

function getMempool(node, cb) {
  rpc(node, 'getrawmempool', [], cb);
}

function fetchMempools(nodes, cb) {
  async.each(nodes, function(node, done) {
    getMempool(node, function(err, mempool) {
      if (!err) {
        node.mempool = mempool;
      }
      done(err);
    });
  }, cb);
}

function getTransaction(txid, node, cb) {
  rpc(node, 'getrawtransaction', [txid], cb); 
}

function sendTransaction(tx, node, cb) {
  request.post({
    url: 'https://blockdozer.com/insight-api/tx/send',
    body: {
      rawtx: tx,
    },
    json:true,
    strictSSL: false
  }, function (err, response, body) {
    if (body && body.error) {
      callback(body.error);
    } else {
      callback(err, (body && body.result) || body);
    }
  });
}

function syncTransaction(txid, sourceNode, targetNode, cb) {
  getTransaction(txid, sourceNode, function(err, tx) {
    if (err) return cb(err);
    sendTransaction(tx, targetNode, cb);
  });
}

/**
 * Compute the union set of all transactions from the mempools
 * of all nodes.  Also, record which node has each transaction.
 */
function getUnionPool(nodes) {
  var items = [];
  var sources = {};
  nodes.forEach(function(node, index) {
    node.mempool.forEach(function(txid) {
      items.push(txid);
      sources[txid] = node;
    });
  });
  return {items: _.uniq(items), sources: sources};
};

/**
 * Perform the actual sync.
 */
fetchMempools(nodes, function(err) {
  if (err) {
    console.log(err);
    return;
  }
  var unionPool = getUnionPool(nodes);
  console.log('Syncing with blockdozer (size: '+unionPool.items.length + ')');

  var failures = [];
  async.eachSeries(unionPool.items, function(txid, done) {
    syncTransaction(txid, unionPool.sources[txid], function(err) {
      if (err) {
        console.log(err);
        failures.push([txid, err.message]);
      } else {
        console.log(txid + ' done!');
      };
      done();
    });
  }, function(err) {
    console.log(failures);
    nodeDone();
  });
});
