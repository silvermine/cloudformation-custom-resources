'use strict';

var expect = require('chai').expect,
    sinon = require('sinon'),
    rewire = require('rewire'),
    DynamoDBGlobalTable = rewire('../src/DynamoDBGlobalTable');

describe('DynamoDBGlobalTable', function() {

   var dynamoStub, baseEvent;

   beforeEach(function() {
      dynamoStub = { send: sinon.stub() };

      // Replace the module-level dynamo client and _delay helper
      DynamoDBGlobalTable.__set__('dynamo', dynamoStub);
      DynamoDBGlobalTable.__set__('_delay', function() {
         return Promise.resolve();
      });
      DynamoDBGlobalTable.__set__('AWS_REGION', 'us-east-1');

      baseEvent = {
         StackId: 'arn:aws:cloudformation:us-east-1:123456789:stack/my-stack/guid',
         RequestId: 'unique-id-1234',
         LogicalResourceId: 'MyGlobalTable',
         PhysicalResourceId: 'my-global-table',
         ResponseURL: 'https://s3.amazonaws.com/bucket/key',
         ResourceProperties: {
            GlobalTableName: 'my-global-table',
            LastStackUpdate: '2026-01-01',
            DeleteUnneededTables: 'false',
            DeploymentRegions: [
               { region: 'us-east-1' },
               { region: 'eu-west-1' },
            ],
         },
         OldResourceProperties: {
            GlobalTableName: 'my-global-table',
            LastStackUpdate: '2025-01-01',
            DeleteUnneededTables: 'false',
            DeploymentRegions: [
               { region: 'us-east-1' },
               { region: 'eu-west-1' },
            ],
         },
      };
   });

   afterEach(function() {
      sinon.restore();
   });

   describe('normalizeResourceProperties', function() {

      it('converts DeleteUnneededTables string "true" to boolean true', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             props;

         props = resource.normalizeResourceProperties({
            DeleteUnneededTables: 'true',
            DeploymentRegions: [ { region: 'us-east-1' } ],
            LastStackUpdate: '2026-01-01',
         }, true);

         expect(props.DeleteUnneededTables).to.strictlyEqual(true);
      });

      it('converts other DeleteUnneededTables values to false', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             props;

         props = resource.normalizeResourceProperties({
            DeleteUnneededTables: 'false',
            DeploymentRegions: [ { region: 'us-east-1' } ],
            LastStackUpdate: '2026-01-01',
         }, true);

         expect(props.DeleteUnneededTables).to.strictlyEqual(false);
      });

      it('builds ReplicationGroup from DeploymentRegions', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             props;

         props = resource.normalizeResourceProperties({
            DeploymentRegions: [ { region: 'us-east-1' }, { region: 'eu-west-1' } ],
            LastStackUpdate: '2026-01-01',
         }, true);

         expect(props.ReplicationGroup).to.eql([
            { RegionName: 'us-east-1' },
            { RegionName: 'eu-west-1' },
         ]);
      });

      it('throws when LastStackUpdate is missing and allowErrors is true', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             fn;

         fn = function() {
            resource.normalizeResourceProperties({
               DeploymentRegions: [ { region: 'us-east-1' } ],
            }, true);
         };

         expect(fn).to.throw('You must supply the LastStackUpdate property');
      });

      it('does not throw when allowErrors is false', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             fn;

         fn = function() {
            resource.normalizeResourceProperties({
               DeploymentRegions: [ { region: 'us-east-1' } ],
            }, false);
         };

         expect(fn).to.not.throw();
      });

   });

   describe('doDelete', function() {

      it('returns the table name without deleting when DeleteUnneededTables is false', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             props;

         props = {
            GlobalTableName: 'my-global-table',
            DeleteUnneededTables: false,
            ReplicationGroup: [
               { RegionName: 'us-east-1' },
               { RegionName: 'eu-west-1' },
            ],
         };

         return resource.doDelete('my-global-table', props).then(function(result) {
            expect(result.PhysicalResourceId).to.strictlyEqual('my-global-table');
            expect(dynamoStub.send.called).to.strictlyEqual(false);
         });
      });

   });

   describe('_hasRequiredStreamSpec', function() {

      it('returns true when NEW_AND_OLD_IMAGES stream is enabled', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             desc;

         desc = {
            StreamSpecification: {
               StreamEnabled: true,
               StreamViewType: 'NEW_AND_OLD_IMAGES',
            },
         };

         expect(resource._hasRequiredStreamSpec(desc)).to.strictlyEqual(true);
      });

      it('returns falsy when stream spec is missing', function() {
         var resource = new DynamoDBGlobalTable(baseEvent);

         expect(resource._hasRequiredStreamSpec({})).to.not.be.ok; // eslint-disable-line no-unused-expressions
      });

      it('returns false when stream type is wrong', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             desc;

         desc = {
            StreamSpecification: {
               StreamEnabled: true,
               StreamViewType: 'KEYS_ONLY',
            },
         };

         expect(resource._hasRequiredStreamSpec(desc)).to.strictlyEqual(false);
      });

   });

   describe('_describeTable', function() {

      it('returns the table description on success', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             tableDesc = { TableName: 'my-table', TableStatus: 'ACTIVE' };

         dynamoStub.send.resolves({ Table: tableDesc });

         return resource._describeTable('my-table', 'us-east-1').then(function(result) {
            expect(result).to.eql(tableDesc);
         });
      });

      it('returns false when the table does not exist', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             err = new Error('not found');

         err.name = 'ResourceNotFoundException';
         dynamoStub.send.rejects(err);

         return resource._describeTable('missing-table', 'us-east-1').then(function(result) {
            expect(result).to.strictlyEqual(false);
         });
      });

      it('rethrows non-ResourceNotFoundException errors', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             err = new Error('access denied');

         err.name = 'AccessDeniedException';
         dynamoStub.send.rejects(err);

         return resource._describeTable('my-table', 'us-east-1')
            .then(function() {
               throw new Error('should have rejected');
            })
            .catch(function(e) {
               expect(e.message).to.strictlyEqual('access denied');
            });
      });

   });

   describe('_describeGlobalTable', function() {

      it('returns the global table description on success', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             desc = { GlobalTableName: 'my-global-table' };

         dynamoStub.send.resolves({ GlobalTableDescription: desc });

         return resource._describeGlobalTable('my-global-table').then(function(result) {
            expect(result).to.eql(desc);
         });
      });

      it('returns false when the global table does not exist', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             err = new Error('not found');

         err.name = 'GlobalTableNotFoundException';
         dynamoStub.send.rejects(err);

         return resource._describeGlobalTable('missing-table').then(function(result) {
            expect(result).to.strictlyEqual(false);
         });
      });

   });

   describe('_describeTableUntilState', function() {

      it('resolves immediately when the table is in the desired state', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             tableDesc = { TableName: 'my-table', TableStatus: 'ACTIVE' };

         dynamoStub.send.resolves({ Table: tableDesc });

         return resource._describeTableUntilState('my-table', 'us-east-1', [ 'ACTIVE' ])
            .then(function(result) {
               expect(result.TableStatus).to.strictlyEqual('ACTIVE');
            });
      });

      it('retries until the table reaches the desired state', function() {
         var resource = new DynamoDBGlobalTable(baseEvent),
             updatingDesc = { TableName: 'my-table', TableStatus: 'UPDATING', TableArn: 'arn' },
             activeDesc = { TableName: 'my-table', TableStatus: 'ACTIVE', TableArn: 'arn' };

         dynamoStub.send.onFirstCall().resolves({ Table: updatingDesc });
         dynamoStub.send.onSecondCall().resolves({ Table: activeDesc });

         return resource._describeTableUntilState('my-table', 'us-east-1', [ 'ACTIVE' ])
            .then(function(result) {
               expect(result.TableStatus).to.strictlyEqual('ACTIVE');
               expect(dynamoStub.send.calledTwice).to.strictlyEqual(true);
            });
      });

   });

});
