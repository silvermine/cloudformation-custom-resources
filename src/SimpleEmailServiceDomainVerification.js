'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    ses = new AWS.SES(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   doCreate: function(props) {
      return Q.ninvoke(ses, 'verifyDomainIdentity', _.pick(props, 'Domain'))
         .then(function(resp) {
            return { PhysicalResourceId: props.Domain, VerificationToken: resp.VerificationToken };
         });
   },

   doDelete: function(resourceID) {
      return Q.ninvoke(ses, 'deleteIdentity', { Identity: resourceID });
   },

   doUpdate: function(resourceID, props, oldProps) {
      return this.doDelete(oldProps.Domain).then(this.doCreate.bind(this, props));
   },

});
