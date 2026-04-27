'use strict';

var _ = require('underscore'),
    { SESClient, SetActiveReceiptRuleSetCommand } = require('@aws-sdk/client-ses'),
    ses = new SESClient(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   doCreate: async function(props) {
      await ses.send(new SetActiveReceiptRuleSetCommand(_.pick(props, 'RuleSetName')));

      return { PhysicalResourceId: props.RuleSetName };
   },

   doUpdate: function(resourceID, props) {
      return this.doCreate(props);
   },

});
