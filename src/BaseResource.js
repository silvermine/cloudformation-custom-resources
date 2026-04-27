'use strict';

var _ = require('underscore'),
    https = require('https'),
    Class = require('class.extend');

module.exports = Class.extend({

   init: function(evt) {
      this._event = evt;
   },

   handleCreate: function() {
      var props = this.normalizeResourceProperties(this._event.ResourceProperties, true);

      console.log('handling creation of "%s": %j', this._event.LogicalResourceId, this._event.ResourceProperties);

      return this.doCreate(props)
         .then(this.respond.bind(this))
         .catch(this.sendError.bind(this));
   },

   handleUpdate: function() {
      var resourceID = this._event.PhysicalResourceId,
          props = this.normalizeResourceProperties(this._event.ResourceProperties, true),
          oldProps = this.normalizeResourceProperties(this._event.OldResourceProperties);

      console.log('handling update of "%s" (%s): %j', this._event.LogicalResourceId, resourceID, props);

      return this.doUpdate(resourceID, props, oldProps)
         .then(this.respond.bind(this))
         .catch(this.sendError.bind(this));
   },

   handleDelete: function() {
      var resourceID = this._event.PhysicalResourceId,
          props = this.normalizeResourceProperties(this._event.ResourceProperties, false);

      console.log('handling delete of "%s" (%s): %j', this._event.LogicalResourceId, resourceID, props);

      return this.doDelete(resourceID, props)
         .then(this.respond.bind(this))
         .catch(this.sendError.bind(this));
   },

   doCreate: function() {
      return Promise.resolve({});
   },

   doUpdate: function() {
      return Promise.resolve({});
   },

   doDelete: function() {
      return Promise.resolve({});
   },

   normalizeResourceProperties: function(props) {
      return props;
   },

   /**
    * See http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
    */
   respond: function(atts) {
      var resp = this._createResponse('SUCCESS', atts.PhysicalResourceId, _.omit(atts, 'PhysicalResourceId'));

      return this._sendResponse(resp);
   },

   _randomResourceID: function() {
      return `${this._event.LogicalResourceId}-${Math.random().toString(36).replace(/[^a-z]+/g, '')}`;
   },

   sendError: function(err) {
      var resp = this._createResponse('FAILED', null, null, err.message);

      console.log('ERROR:', err, err.stack);

      return this._sendResponse(resp);
   },

   _createResponse: function(status, resourceID, data, reason) {
      return {
         StackId: this._event.StackId,
         RequestId: this._event.RequestId,
         LogicalResourceId: this._event.LogicalResourceId,
         PhysicalResourceId: resourceID || this._event.PhysicalResourceId || this._randomResourceID(),
         Status: status,
         Reason: reason || undefined,
         Data: data,
      };
   },

   _sendResponse: function(resp) {
      var body = JSON.stringify(resp),
          parsedURL = new URL(this._event.ResponseURL),
          opts;

      console.log('Sending response to S3:', body);

      opts = {
         hostname: parsedURL.hostname,
         port: 443,
         path: parsedURL.pathname + parsedURL.search,
         method: 'PUT',
         headers: {
            'Content-Type': '',
            'Content-Length': body.length,
         },
      };

      return new Promise(function(resolve, reject) {
         var req;

         req = https.request(opts, function(response) {
            console.log('PUT response status:', response.statusCode);
            console.log('PUT response headers:', JSON.stringify(response.headers));
            resolve(resp);
         });

         req.on('error', function(err) {
            console.log('ERROR sending PUT request', err, err.stack);
            reject(err);
         });

         req.on('end', function() {
            console.log('end request');
         });

         req.write(body);
         req.end();
      });
   },

});
