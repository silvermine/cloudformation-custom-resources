'use strict';

var _ = require('underscore'),
    BaseResource = require('./BaseResource'),
    AWS = require('aws-sdk'),
    elasticsearch = new AWS.ES(),
    POLL_DELAY = 5000;

module.exports = BaseResource.extend({

   doCreate: async function(props) {
      const createPackageParams = {
         PackageName: props.PackageName,
         PackageType: props.PackageType,
         PackageDescription: props.PackageDescription,
         PackageSource: {
            S3BucketName: props.PackageSource.S3BucketName,
            S3Key: props.PackageSource.S3Key,
         },
      };

      const createPackageResp = await elasticsearch.createPackage(createPackageParams).promise(),
            packageID = createPackageResp.PackageDetails.PackageID;

      console.log(
         `Created package ${createPackageResp.PackageDetails.PackageName} (${packageID}),`
         + ` current status: ${createPackageResp.PackageDetails.PackageStatus}`
      );

      await this._waitForPackageToBeAvailable(packageID);

      await elasticsearch
         .associatePackage({
            DomainName: props.DomainName,
            PackageID: packageID,
         })
         .promise();

      const domainPackageDetails = await this._waitForPackageToBeAssociatedToDomain(packageID, props.DomainName);

      return {
         PhysicalResourceId: packageID,
         ReferencePath: domainPackageDetails.ReferencePath,
      };
   },

   doDelete: async function(resourceID, props) {
      await elasticsearch
         .dissociatePackage({
            DomainName: props.DomainName,
            PackageID: resourceID,
         })
         .promise();

      await this._waitForPackageToBeDissociatedWithAllDomains(resourceID);

      await elasticsearch.deletePackage({ PackageID: resourceID }).promise();

      return { PhysicalResourceId: resourceID };
   },

   doUpdate: async function(resourceID, props) {
      await elasticsearch
         .updatePackage({
            PackageID: resourceID,
            PackageSource: {
               S3BucketName: props.PackageSource.S3BucketName,
               S3Key: props.PackageSource.S3Key,
            },
            PackageDescription: props.PackageDescription,
         })
         .promise();

      await this._waitForPackageToBeAvailable(resourceID);

      await elasticsearch
         .associatePackage({
            DomainName: props.DomainName,
            PackageID: resourceID,
         })
         .promise();

      const domainPackageDetails = await this._waitForPackageToBeAssociatedToDomain(resourceID, props.DomainName);

      return {
         PhysicalResourceId: resourceID,
         ReferencePath: domainPackageDetails.ReferencePath,
      };
   },

   _waitForPackageToBeAvailable: function(packageID) {
      return new Promise((resolve, reject) => {
         async function loop() {
            try {
               const describePackagesResp = await elasticsearch
                  .describePackages({ Filters: [ { Name: 'PackageID', Value: [ packageID ] } ] })
                  .promise();

               if (!describePackagesResp.PackageDetailsList || describePackagesResp.PackageDetailsList.length === 0) {
                  console.log(`Package ${packageID} was not found`);
               } else if (describePackagesResp.PackageDetailsList[0]) {
                  console.log(`Package ${packageID} has status ${describePackagesResp.PackageDetailsList[0].PackageStatus}`);

                  if (describePackagesResp.PackageDetailsList[0].PackageStatus === 'AVAILABLE') {
                     resolve();
                     return;
                  }
               }

               setTimeout(loop, POLL_DELAY);
            } catch(e) {
               reject(e);
            }
         }

         setTimeout(loop, 1000);
      });
   },

   _waitForPackageToBeAssociatedToDomain: function(packageID, domainName) {
      return new Promise((resolve, reject) => {
         async function loop() {
            try {
               const listPackagesForDomainResp = await elasticsearch.listDomainsForPackage({ PackageID: packageID }).promise();

               if (listPackagesForDomainResp.DomainPackageDetailsList && listPackagesForDomainResp.DomainPackageDetailsList.length > 0) {
                  const targetDomainAssociation = listPackagesForDomainResp.DomainPackageDetailsList.find((domainPackageDetails) => {
                     return domainPackageDetails.DomainName === domainName;
                  });

                  if (targetDomainAssociation) {
                     console.log(`Package ${packageID} has a status of ${targetDomainAssociation.DomainPackageStatus} with ${domainName}`);

                     if (targetDomainAssociation.DomainPackageStatus === 'ACTIVE') {
                        resolve(targetDomainAssociation);
                        return;
                     }
                  }

                  console.log(`Package ${packageID} is not associated with ${domainName}`);
               } else {
                  console.log(`No domain associations for package ${packageID} were found`);
               }

               setTimeout(loop, POLL_DELAY);
            } catch(e) {
               reject(e);
            }
         }

         setTimeout(loop, 1000);
      });
   },

   _waitForPackageToBeDissociatedWithAllDomains: function(packageID) {
      return new Promise((resolve, reject) => {
         async function loop() {
            try {
               const listPackagesForDomainResp = await elasticsearch.listDomainsForPackage({ PackageID: packageID }).promise();

               if (!listPackagesForDomainResp.DomainPackageDetailsList || listPackagesForDomainResp.DomainPackageDetailsList.length === 0) {
                  resolve();
                  return;
               }

               console.log(
                  `Package ${packageID} is associated with `
                  + JSON.stringify(_.pick(listPackagesForDomainResp.DomainPackageDetailsList, 'DomainName'))
               );
               setTimeout(loop, POLL_DELAY);
            } catch(e) {
               reject(e);
            }
         }

         setTimeout(loop, 1000);
      });
   },

});
