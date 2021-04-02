'use strict';

const Q = require('q'),
      AWS = require('aws-sdk'),
      Class = require('class.extend'),
      URL = require('url').URL,
      credentials = new AWS.EnvironmentCredentials('AWS'),
      client = new AWS.HttpClient();

module.exports = Class.extend({

   init: function(region, domain) {
      this._region = region;
      this._domain = domain;
   },

   send: function(method, path, body) {
      const url = new URL(path, `https://${this._domain}`),
            endpoint = new AWS.Endpoint(url.toString()),
            request = new AWS.HttpRequest(endpoint, this._region);

      request.method = method;
      request.body = JSON.stringify(body || {});
      request.headers.Host = url.host;
      request.headers['Content-Type'] = 'application/json';
      request.headers['Content-Length'] = Buffer.byteLength(request.body);

      const signer = new AWS.Signers.V4(request, 'es'),
            deferred = Q.defer();

      signer.addAuthorization(credentials, new Date());

      client.handleRequest(
         request,
         null,
         function(response) {
            let responseBody = '';

            response.on('data', function(chunk) {
               responseBody += chunk;
            });

            response.on('end', function() {
               const data = {
                  statusCode: response.statusCode,
                  statusMessage: response.statusMessage,
                  headers: response.headers,
               };

               if (responseBody) {
                  try {
                     data.body = JSON.parse(responseBody);
                  } catch(e) {
                     console.log('Invalid JSON body:', responseBody, e);
                     deferred.reject(new Error('Request failed due to invalid JSON body. Raw Body: ' + responseBody));
                  }
               }

               if (response.statusCode === 200) {
                  deferred.resolve(data);
               } else {
                  deferred.reject(new Error('Request failed with ' + response.statusCode + '. Body: ' + JSON.stringify(data.body)));
               }
            });

         },
         deferred.reject
      );

      return deferred.promise;
   },

});
