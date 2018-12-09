'use strict';

var Q = require('q'),
    AWS = require('aws-sdk'),
    elbv2 = new AWS.ELBv2(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   _makeTargetsParams: function(props) {
      return {
         TargetGroupArn: props.TargetGroupArn,
         Targets: [ { Id: props.TargetFunctionArn } ],
      };
   },

   doCreate: function(props) {
      return Q.ninvoke(elbv2, 'registerTargets', this._makeTargetsParams(props))
         .then(function() {
            return { PhysicalResourceId: props.FunctionArn };
         });
   },

   doDelete: function(resourceID, props) {
      return Q.ninvoke(elbv2, 'deregisterTargets', this._makeTargetsParams(props));
   },

   doUpdate: function(resourceID, props, oldProps) {
      return this.doDelete(resourceID, oldProps).then(this.doCreate.bind(this, props));
   },

});
