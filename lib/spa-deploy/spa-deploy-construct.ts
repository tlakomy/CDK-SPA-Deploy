import cdk = require('@aws-cdk/core');
import s3deploy= require('@aws-cdk/aws-s3-deployment');
import s3 = require('@aws-cdk/aws-s3');
import { CloudFrontWebDistribution, ViewerCertificate } from '@aws-cdk/aws-cloudfront'
import { PolicyStatement } from '@aws-cdk/aws-iam';
import { HostedZone, ARecord, RecordTarget } from '@aws-cdk/aws-route53';
import { DnsValidatedCertificate } from '@aws-cdk/aws-certificatemanager';
import { HttpsRedirect } from '@aws-cdk/aws-route53-patterns';
import { CloudFrontTarget } from '@aws-cdk/aws-route53-targets';

export interface SPADeployConfig {
  readonly indexDoc:string,
  readonly websiteFolder: string,
  readonly certificateARN?: string,
  readonly cfAliases?: string[],
  readonly exportWebsiteUrlOutput?:boolean,
  readonly exportWebsiteUrlName?: string
}

export interface HostedZoneConfig {
  readonly indexDoc:string,
  readonly websiteFolder: string,
  readonly zoneName: string
}

export interface SPAGlobalConfig {
  readonly encryptBucket?:boolean,
  readonly ipFilter?:boolean,
  readonly ipList?:string[]
}

export class SPADeploy extends cdk.Construct {
    globalConfig: SPAGlobalConfig;
    
    constructor(scope: cdk.Construct, id:string, config?:SPAGlobalConfig){
        super(scope, id);
        
        if(typeof config != 'undefined'){
          this.globalConfig = config;
        } else {
          this.globalConfig = {
            encryptBucket:false,
            ipFilter: false
          }
        }
    }
    
    /**
     * Helper method to provide a configured s3 bucket
     */
    private getS3Bucket(config:SPADeployConfig) {
      
      let bucketConfig:any = {
          websiteIndexDocument: config.indexDoc,
          publicReadAccess: true
        };
        
      if(this.globalConfig.encryptBucket === true){
        bucketConfig.encryption = s3.BucketEncryption.S3_MANAGED
      }
      
      if(this.globalConfig.ipFilter === true){
        bucketConfig.publicReadAccess = false;
      }
        
      let bucket = new s3.Bucket(this, 'WebsiteBucket', bucketConfig);
      
      if(this.globalConfig.ipFilter === true){
        if(typeof this.globalConfig.ipList == 'undefined') {
          this.node.addError('When IP Filter is true then the IP List is required');
        }
        
        const bucketPolicy = new PolicyStatement();
        bucketPolicy.addAnyPrincipal();
        bucketPolicy.addActions('s3:GetObject');
        bucketPolicy.addResources(bucket.bucketArn + '/*');
        bucketPolicy.addCondition('IpAddress', {
          'aws:SourceIp': this.globalConfig.ipList
        });
        
        bucket.addToResourcePolicy(bucketPolicy);
      }
      
      return bucket;
    }
    
    /**
     * Helper method to provide configuration for cloudfront 
     */
    private getCFConfig(websiteBucket:s3.Bucket, config:any, cert?:DnsValidatedCertificate) {
         let cfConfig:any = {
          originConfigs: [
            {
              s3OriginSource: {
                s3BucketSource: websiteBucket
              },
              behaviors : [ {isDefaultBehavior: true}]
            }
          ],
          //We need to redirect all unknown routes back to index.html for angular routing to work
          errorConfigurations: [{
            errorCode: 403,
            responsePagePath: '/'+config.indexDoc,
            responseCode: 200
          },
          {
            errorCode: 404,
            responsePagePath: '/'+config.indexDoc,
            responseCode: 200
          }]
        }
        
        if(typeof config.certificateARN != 'undefined' && typeof config.cfAliases != 'undefined') {
            cfConfig.aliasConfiguration = {
                acmCertRef: config.certificateARN,
                names: config.cfAliases
            }
        }
        
        if(typeof config.zoneName !='undefined' && typeof cert != 'undefined'){
          cfConfig.viewerCertificate = ViewerCertificate.fromAcmCertificate(cert, {
            aliases: [config.zoneName],
          })
        }
        
        return cfConfig;
    }
    
    /**
     * Basic setup needed for a non-ssl, non vanity url, non cached s3 website
     */
    public createBasicSite(config:SPADeployConfig) {
        const websiteBucket = this.getS3Bucket(config);
        
        new s3deploy.BucketDeployment(this, 'BucketDeployment', {
          sources: [s3deploy.Source.asset(config.websiteFolder)], 
          destinationBucket: websiteBucket,
        });
        
        let cfnOutputConfig:any = {
          description: 'The url of the website',
          value: websiteBucket.bucketWebsiteUrl
        };

        if (config.exportWebsiteUrlOutput === true) {
          if(typeof config.exportWebsiteUrlName == 'undefined' || config.exportWebsiteUrlName === '') {
            this.node.addError('When Output URL as AWS Export property is true then the output name is required');
          }
          cfnOutputConfig.exportName = config.exportWebsiteUrlName;
        }

        new cdk.CfnOutput(this, 'URL', cfnOutputConfig);
    }
    
    /**
     * This will create an s3 deployment fronted by a cloudfront distribution
     * It will also setup error forwarding and unauth forwarding back to indexDoc
     */
    public createSiteWithCloudfront(config:SPADeployConfig) {
        const websiteBucket = this.getS3Bucket(config);
        const distribution = new CloudFrontWebDistribution(this, 'cloudfrontDistribution', this.getCFConfig(websiteBucket, config));
        
        new s3deploy.BucketDeployment(this, 'BucketDeployment', {
          sources: [s3deploy.Source.asset(config.websiteFolder)], 
          destinationBucket: websiteBucket,
          //Invalidate the cache for / and index.html when we deploy so that cloudfront serves latest site
          distribution: distribution,
          distributionPaths: ['/', '/'+config.indexDoc]
        });
        
        new cdk.CfnOutput(this, 'cloudfront domain', {
          description: 'The domain of the website',
          value: distribution.domainName
        })
    }
    
    /**
     * S3 Deployment, cloudfront distribution, ssl cert and error forwarding auto
     * configured by using the details in the hosted zone provided
     */
    public createSiteFromHostedZone(config:HostedZoneConfig) {
       const websiteBucket = this.getS3Bucket(config);
       let zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: config.zoneName });
       let cert = new DnsValidatedCertificate(this, 'Certificate', {
                hostedZone: zone,
                domainName: config.zoneName,
                region: 'us-east-1',
            });
            
        const distribution = new CloudFrontWebDistribution(this, 'cloudfrontDistribution', this.getCFConfig(websiteBucket, config, cert));
        
        new s3deploy.BucketDeployment(this, 'BucketDeployment', {
          sources: [s3deploy.Source.asset(config.websiteFolder)], 
          destinationBucket: websiteBucket,
          //Invalidate the cache for / and index.html when we deploy so that cloudfront serves latest site
          distribution: distribution,
          distributionPaths: ['/', '/'+config.indexDoc]
        });
        
        new ARecord(this, 'Alias', {
          zone,
          recordName: config.zoneName,
          target: RecordTarget.fromAlias(new CloudFrontTarget(distribution))
        })

        new HttpsRedirect(this, 'Redirect', {
            zone,
            recordNames: ['www.'+config.zoneName],
            targetDomain: config.zoneName,
        });
    }
    
}