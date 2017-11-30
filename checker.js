"use strict";

const socks = require('proxysocket');
const dns = require('dns');
const net = require('net');
const Prom = require('bluebird');
const args = require('minimist')(process.argv.slice(2));

//
// 1. Get all MX records (if any)
////
function resolveHostInfo(addr){
  let mxs = []; //MX reords

  dns.resolveMx(addr, (err, response) => {

    //ok, if there's any dns errors - just return empty MX list
    if(err == null){
      response.forEach((entry) => {
        mxs.push(entry.exchange);
      });
    }

    findAliveMx(mxs);
  });
}

//
// 2. Find alive smtp server in MX records
////
function findAliveMx(mxs){
  var done = false; //whenever iterator should stop processing items

  Prom.each(mxs, (addr) => {
    return checkAddrOnline(addr)
      .then(res => {
        if(!done){
          done = true;
          formatResults(mxs, res, addr);
        }
      }).catch(failure => {/*void*/});
  }).then(() => {
    if(!done){ //all servers offline
      formatResults(mxs, {server_is_online: false}, null);
    }
  });
}

//
//2.1. Check if smtp server is alive & save HELO reply
////
function checkAddrOnline(addr){
  
  let client = (proxy_host == null) ? new net.Socket() : socks.create(proxy_host, proxy_port);

  return new Promise((found, failed) => {
    client.on('error', (err) => {
      if(args.v){console.log("Connection failed: " + err)};
      failed({server_is_online: false});
    });

    client.on('data', data => {
      client.destroy();

      let reply = data.toString().trim(); //raw Buffer to plain string
      if(reply.startsWith("220")){
        found({server_is_online: true, server_helo_response: reply});
      } else {
        if(args.v){console.log("Inavlid SMTP response header: " + data)};
        failed({server_is_online: false});
      }
    });

    //meh, ugly bug in 'proxysocket' lib
    (proxy_host == null) ? client.connect(port, addr) : client.connect(addr, port);
  });
}

//
//3. Try to retrive user info
////
function trySendMessage(addr){

  if(addr == null){ //there is no servers alive
    return new Promise(done => {done({
      address_exists: false,
      wrong_address_accepted: false,
      rcpt_to_response: "",
      mail_from_response: ""
    });});
  }

  let client = (proxy_host == null) ? new net.Socket() : socks.create(proxy_host, proxy_port);
  let state = 0; //current FSM state, from 0 (connecting) to 3(RCPT TO for non-existent user)
  let codes = ["220", "250"]; //valid server response codes
  let response = {}; //our final reply

  return new Promise((done, fail) => {

    client.on('data', data => {
      if(args.v){console.log("state/reply: " + state + "/" + data)};

      let result = data.toString();
      let code = result.substring(0,3);

      //validate server response code
      if(codes.indexOf(code) == -1){

        if(state == 3){ //primary RCPT TO
          response.address_exists = false;
          response.rcpt_to_response = result;
        } else if(state == 4){ //final RCPT TO check
          response.wrong_address_accepted = false;
        }
      }

      switch(state){
        case 0:
        {
          client.write("EHLO example.com\r\n");
          state++;
          break;
        }
        case 1:
        {
          client.write("MAIL FROM: <" + sender + ">\r\n");
          state++;
          break;
        }
        case 2:
        {
          response.mail_from_response = result.trim();
          client.write("RCPT TO: <" + email + ">\r\n");
          state++;
          break;
        }
        case 3: //check for no-existent user
        {
          if(typeof response.address_exists === 'undefined'){ //check if previous RCPT_TO was failed
            response.rcpt_to_response = result.trim();
            response.address_exists = true;
          }

          client.write("RCPT TO: <a.b.c.d@wwrronggmail.com>\r\n");
          state++;
          break;
        }
        default:{

          if(typeof response.wrong_address_accepted === 'undefined'){ //wrong destiation address accepted?
            response.wrong_address_accepted = true;
          }

          client.destroy();
          done(response);
        }
      }
    });

    client.on('error', err => {
      client.destroy();
      fail(err);
    });

    (proxy_host == null) ? client.connect(port, addr) : client.connect(addr, port);
  });
}

//
//4. Finally, print out results
////
function formatResults(mxs, serverReply, item){
  if(args.v){console.log("finally -> " + item)};

  trySendMessage(item).then(res => {
    let result = serverReply;
    result.rcpt_to_respose = res.rcpt_to_response;
    result.address_exists = res.address_exists;
    result.mail_from_resposne = res.mail_from_response;
    result.wrong_address_accepted = res.wrong_address_accepted;
    result.address = validEmailStr(email);
    result.mx_exists = mxs.length > 0;
    result.mx_domains = mxs;
    console.dir(result);
  }).catch(fail => {
    console.log("Error: " + fail);
  });
}


function validEmailStr(mail){
  return (/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(mail));
}


//
// Enty point
////

//command line args parsing
let input = process.argv.slice(2);
if(input.length < 1 || input[0].indexOf("@") == -1){
  console.log("Usage: checker <email> [-v(erbose)] [--proxy=address]");
  return;
}

let proxy_host = null
let proxy_port = null;
if(typeof args.proxy !== 'undefined'){
  if(args.proxy.lastIndexOf("/") != -1){ proxy_host = args.proxy.substring(args.proxy.lastIndexOf("/") + 1); }
  if(proxy_host.lastIndexOf(":") != -1){
    let arr = proxy_host.split(":");
    proxy_host = arr[0];
    proxy_port = arr[1];
  }
}

if(args.v && proxy_host != null){console.log("Using proxy at " + proxy_host + ":" + proxy_port)};

let email = input[0];
let host = input[0].split("@")[1];
let port = 25;
let sender = "test@example.com";

resolveHostInfo(host, email);
