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
  rpc(node, 'sendrawtransaction', [tx], cb);
}

function syncTransaction(txid, sourceNode, targetNode, cb) {
  getTransaction(txid, sourceNode, function(err, tx) {
    if (err) return cb(err);
    sendTransaction(tx, targetNode, cb);
  });
}

function syncNode(node, unionPool, progressBar, cb) {
  var missingInputs = [];
  if(!node.failures) node.failures = [];
  async.eachSeries(node.missing, function(txid, done) {
    syncTransaction(txid, unionPool.sources[txid], node, function(err) {
      if (err && (err.message === 'Missing inputs')) {
        missingInputs.push(txid);
      } else if (err) {
        progressBar && progressBar.tick();
        if (err.message != 'transaction already in block chain') {
          node.failures.push([txid, err.message]);
        }
      } else {
        progressBar && progressBar.tick();
      };
      done();
    });
  }, function(err) {
    cb(err, missingInputs);
  });
}

/**
 * Sync the given node in multiple passes to deal with transactions
 * that have missing inputs.  Keep track of the count of missing 
 * transactions during each pass and if a pass fails to reduce the
 * number of missing transactions, stop.
 */
function syncNodeMultiPass(node, unionPool, progressBar, cb) {
  var lastMissingCount = node.missing.length + 1;
  async.whilst(function() {
    return node.missing.length < lastMissingCount;
  }, function(done) {
    lastMissingCount = node.missing.length;
    syncNode(node, unionPool, progressBar, function(err, missingInputs) {
      if (node.missing = missingInputs);
      done(err);
    });
  }, cb);
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
 * Compute the set of transactions missing for each node
 * relative to the union set.
 */
function getDiffs(nodes, unionPool) {
  nodes.forEach(function(node) {
    node.missing = _.difference(unionPool.items, node.mempool);
  });
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
  getDiffs(nodes, unionPool);
  async.eachOfSeries(nodes, function(node, index, nodeDone) {
    if (index) console.log(); // emit a blank line between each node
    console.log('Syncing', node.name || node.host, '(size: '+node.mempool.length+', missing: '+node.missing.length+'):');
    var progressBar = new ProgressBar(':bar (:current of :total)', { total: node.missing.length, width: 10 });
    syncNodeMultiPass(node, unionPool, progressBar, function(err) {
      if (err) return nodeDone(err); 
      progressBar.tick(node.missing.length);
      node.failures.forEach(function(ea) {
        console.log(ea[0]+': '+ea[1]);
      });
      node.missing.forEach(function(ea) {
        console.log(ea+': missing inputs');
      });
      nodeDone();
    });
  }, function(err) {
    if (err) console.log('error:', err);
  });
});
