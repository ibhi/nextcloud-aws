const region = 'ap-south-1';

var AWS = require('aws-sdk');
AWS.config.update({ region: region });

const cloudformation = new AWS.CloudFormation();

exports.handler = (event, context, callback) => {
    console.log('Event', event);
    const messageId = event.Records[0].Sns.MessageId;
    const message = event.Records[0].Sns.Message;

    if(message === 'CREATE') {
        createStack(callback);
    } else if(message === 'DELETE') {
        deleteStack(callback);
    } else {
        callback(err);
    }

};

function createStack(callback) {
    const params = {
        StackName: 'pms', /* required */
        Capabilities: [
            'CAPABILITY_NAMED_IAM'
        ],
        Parameters: [
            {
                ParameterKey: 'NetworkStackName',
                ParameterValue: 'pms-vpc'
            },
            {
                ParameterKey: 'SourceCidr',
                ParameterValue: '0.0.0.0/0'
            },
            {
                ParameterKey: 'KeyName',
                ParameterValue: 'personal-media-server'
            },
            {
                ParameterKey: 'SpotPrice',
                ParameterValue: '0.1'
            },
            {
                ParameterKey: 'DomainName',
                ParameterValue: 'ibhi.tk'
            },
            {
                ParameterKey: 'CacheSnapshotId',
                ParameterValue: 'snap-01f85e7c0b6f9b82f'
            },
            {
                ParameterKey: 'GDriveSecret',
                ParameterValue: 'arn:aws:secretsmanager:ap-south-1:782677160809:secret:gdrive-token-EFr0g3'
            }
            /* more items */
        ],
        RoleARN: '\${PMSCloudFormationStackCreationRoleArn}',
        Tags: [
            {
                Key: 'Name', /* required */
                Value: 'pms' /* required */
            },
            /* more items */
        ],
        TemplateURL: 'https://s3.ap-south-1.amazonaws.com/cf-templates-1g7z2nh3wiuu3-ap-south-1/pms.json',
    };
    cloudformation.createStack(params, (err, data) => {
        if (err) {
            console.log(err, err.stack); // an error occurred
            callback(err);
        } else {
            console.log(data);           // successful response
            callback(null, data);
        }
    });
}

function deleteStack(callback) {
    const params = {
        // Todo: make it dynamic
        StackName: 'pms',
        RoleARN: '\${PMSCloudFormationStackCreationRoleArn}'
    };
    cloudformation.deleteStack(params, (err, data) => {
        if (err) {
            console.log(err, err.stack); // an error occurred
            callback(err);
        } else {
            console.log(data);           // successful response
            callback(null, data);
        }
    });
}