'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    cloudfront = new AWS.CloudFront(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   doCreate: function(props) {
      var params = { CloudFrontOriginAccessIdentityConfig: _.pick(props, 'CallerReference', 'Comment') };

      return Q.ninvoke(cloudfront, 'createCloudFrontOriginAccessIdentity', params)
         .then(function(resp) {
            var data = resp.CloudFrontOriginAccessIdentity;

            return { PhysicalResourceId: data.Id, S3CanonicalUserId: data.S3CanonicalUserId };
         });
   },

   doDelete: function(resourceID) {
      return Q.ninvoke(cloudfront, 'getCloudFrontOriginAccessIdentityConfig', { Id: resourceID })
         .then(function(resp) {
            return Q.ninvoke(cloudfront, 'deleteCloudFrontOriginAccessIdentity', { Id: resourceID, IfMatch: resp.ETag });
         });
   },

   doUpdate: function(resourceID, props) {
      return Q.ninvoke(cloudfront, 'getCloudFrontOriginAccessIdentityConfig', { Id: resourceID })
         .then(function(resp) {
            var params;

            params = {
               Id: resourceID,
               IfMatch: resp.ETag,
               CloudFrontOriginAccessIdentityConfig: _.pick(props, 'CallerReference', 'Comment'),
            };

            return Q.ninvoke(cloudfront, 'updateCloudFrontOriginAccessIdentity', params);
         })
         .then(function(resp) {
            var data = resp.CloudFrontOriginAccessIdentity;

            return { PhysicalResourceId: data.Id, S3CanonicalUserId: data.S3CanonicalUserId };
         });
   },

});
