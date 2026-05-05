'use strict';

const _ = require('underscore'),
      https = require('https');

class BaseResource {

   constructor(evt) {
      this._event = evt;
   }

   async handleCreate() {
      const props = this.normalizeResourceProperties(this._event.ResourceProperties, true);

      console.log('handling creation of "%s": %j', this._event.LogicalResourceId, this._event.ResourceProperties);

      try {
         const atts = await this.doCreate(props);

         return await this.respond(atts);
      } catch(err) {
         return this.sendError(err);
      }
   }

   async handleUpdate() {
      const resourceID = this._event.PhysicalResourceId,
            props = this.normalizeResourceProperties(this._event.ResourceProperties, true),
            oldProps = this.normalizeResourceProperties(this._event.OldResourceProperties);

      console.log('handling update of "%s" (%s): %j', this._event.LogicalResourceId, resourceID, props);

      try {
         const atts = await this.doUpdate(resourceID, props, oldProps);

         return await this.respond(atts);
      } catch(err) {
         return this.sendError(err);
      }
   }

   async handleDelete() {
      const resourceID = this._event.PhysicalResourceId,
            props = this.normalizeResourceProperties(this._event.ResourceProperties, false);

      console.log('handling delete of "%s" (%s): %j', this._event.LogicalResourceId, resourceID, props);

      try {
         const atts = await this.doDelete(resourceID, props);

         return await this.respond(atts);
      } catch(err) {
         return this.sendError(err);
      }
   }

   async doCreate() {
      return {};
   }

   async doUpdate() {
      return {};
   }

   async doDelete() {
      return {};
   }

   normalizeResourceProperties(props) {
      return props;
   }

   /**
    * See http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
    */
   async respond(atts) {
      const resp = this._createResponse('SUCCESS', atts.PhysicalResourceId, _.omit(atts, 'PhysicalResourceId'));

      return this._sendResponse(resp);
   }

   _randomResourceID() {
      return `${this._event.LogicalResourceId}-${Math.random().toString(36).replace(/[^a-z]+/g, '')}`;
   }

   async sendError(err) {
      const resp = this._createResponse('FAILED', null, null, err.message);

      console.log('ERROR:', err, err.stack);

      return this._sendResponse(resp);
   }

   _createResponse(status, resourceID, data, reason) {
      return {
         StackId: this._event.StackId,
         RequestId: this._event.RequestId,
         LogicalResourceId: this._event.LogicalResourceId,
         PhysicalResourceId: resourceID || this._event.PhysicalResourceId || this._randomResourceID(),
         Status: status,
         Reason: reason || undefined,
         Data: data,
      };
   }

   _sendResponse(resp) {
      const body = JSON.stringify(resp),
            parsedURL = new URL(this._event.ResponseURL);

      console.log('Sending response to S3:', body);

      const opts = {
         hostname: parsedURL.hostname,
         port: 443,
         path: `${parsedURL.pathname}${parsedURL.search}`,
         method: 'PUT',
         headers: {
            'Content-Type': '',
            'Content-Length': body.length,
         },
      };

      return new Promise((resolve, reject) => {
         const req = https.request(opts, (response) => {
            response.resume();
            console.log('PUT response status:', response.statusCode);
            console.log('PUT response headers:', JSON.stringify(response.headers));
            resolve(resp);
         });

         req.on('error', (err) => {
            console.log('ERROR sending PUT request', err, err.stack);
            reject(err);
         });

         req.on('end', () => {
            console.log('end request');
         });

         req.write(body);
         req.end();
      });
   }

}

module.exports = BaseResource;
