'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    elbv2 = new AWS.ELBv2(),
    BaseResource = require('./BaseResource'),
    COPIED_PROPS;

COPIED_PROPS = [
   'Name',
   // All of these are for health checks:
   'HealthCheckProtocol',
   'HealthCheckPort',
   'HealthCheckEnabled',
   'HealthCheckPath',
   'HealthCheckIntervalSeconds',
   'HealthCheckTimeoutSeconds',
   'HealthyThresholdCount',
   'UnhealthyThresholdCount',
   'Matcher',
];

module.exports = BaseResource.extend({

   _getTargetGroupProps: function(props) {
      return _.extend(_.pick(props, COPIED_PROPS), {
         // Because this custom resource only exists to support Lambda during the interim
         // period where Lambda isn't supported, we only allow it to be used with the
         // Lambda target type.
         TargetType: 'lambda',
      });
   },

   _getAttsParams: function(props, resp) {
      var params;

      params = {
         TargetGroupArn: resp.TargetGroups[0].TargetGroupArn,
         Attributes: props.TargetGroupAttributes || [],
      };

      if (_.isEmpty(params.Attributes)) {
         // If someone removed all params, we simply set this param back to the default
         // because you can not pass an empty params object to the
         // modifyTargetGroupAttributes call. ELBv2 requires the value to be a string.
         params.Attributes = [ { Key: 'lambda.multi_value_headers.enabled', Value: 'false' } ];
      }

      return params;
   },

   doCreate: function(props) {
      var params = this._getTargetGroupProps(props);

      return Q.ninvoke(elbv2, 'createTargetGroup', params)
         .then(function(resp) {
            var data = _.first(resp.TargetGroups);

            return Q.ninvoke(elbv2, 'modifyTargetGroupAttributes', this._getAttsParams(props, resp))
               .thenResolve({ PhysicalResourceId: data.TargetGroupArn });
         }.bind(this));
   },

   doUpdate: function(resourceID, props, oldProps) {
      var params = this._getTargetGroupProps(props),
          isNameChange = (!_.isEmpty(params.Name) && (props.Name !== oldProps.Name));

      if (isNameChange) {
         // We can't actually modify the name, so we replace it (CloudFormation should
         // call delete automatically later because our doCreate will return a new ARN,
         // and CFN will realize that we replaced the old one)
         return this.doCreate(props);
      }

      delete params.Name;
      delete params.TargetType;
      params.TargetGroupArn = resourceID;

      return Q.ninvoke(elbv2, 'modifyTargetGroup', params)
         .then(function(resp) {
            var data = _.first(resp.TargetGroups);

            return Q.ninvoke(elbv2, 'modifyTargetGroupAttributes', this._getAttsParams(props, resp))
               .thenResolve({ PhysicalResourceId: data.TargetGroupArn });
         }.bind(this));
   },

   doDelete: function(resourceID) {
      return Q.ninvoke(elbv2, 'deleteTargetGroup', { TargetGroupArn: resourceID })
         .catch(function(err) {
            if (_.isString(resourceID) && resourceID.substring(0, 4) === 'arn:') {
               // The resource ID was in the ARN format, so this is a real error - just
               // re-throw it so that it gets picked up by CloudFormation.
               throw err;
            }
            // otherwise, the resource never really was created, so we can't delete it,
            // and we log and squash this error
            console.log('Warning: squashed error:', err, err.stack);
            return { PhysicalResourceId: resourceID };
         });
   },

});
