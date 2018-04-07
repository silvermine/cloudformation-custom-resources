'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    ses = new AWS.SES(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   doCreate: function(props) {
      return Q.ninvoke(ses, 'setActiveReceiptRuleSet', _.pick(props, 'RuleSetName'))
         .thenResolve({ PhysicalResourceId: props.RuleSetName });
   },

   doUpdate: function(resourceID, props) {
      return this.doCreate(props);
   },

});
