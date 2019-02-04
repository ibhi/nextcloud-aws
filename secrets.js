// Load the AWS SDK
const AWS = require('aws-sdk'),
    endpoint = "https://secretsmanager.ap-south-1.amazonaws.com",
    region = "ap-south-1",
    secretName = "prod/app/nextcloud-secrets";

const fs = require('fs');

// Create a Secrets Manager client
const client = new AWS.SecretsManager({
    endpoint: endpoint,
    region: region
});

AWS.config.logger = console;

client.getSecretValue({ SecretId: secretName }, (err, data) => {
    console.log("Inside code");
    if (err) {
        if (err.code === 'ResourceNotFoundException')
            console.log("The requested secret " + secretName + " was not found");
        else if (err.code === 'InvalidRequestException')
            console.log("The request was invalid due to: " + err.message);
        else if (err.code === 'InvalidParameterException')
            console.log("The request had invalid params: " + err.message);
    }
    else {
        // Decrypted secret using the associated KMS CMK
        // Depending on whether the secret was a string or binary, one of these fields will be populated
        let secret;
        if (data.SecretString !== "") {
            secret = JSON.parse(data.SecretString);
            const fileContent = `#!/bin/bash -xe
export NEXTCLOUD_ADMIN_USER=${secret.nextcloud_admin_user}
export NEXTCLOUD_ADMIN_PASSWORD=${secret.nextcloud_admin_password}
export MYSQL_DATABASE=${secret.mysql_database}
export MYSQL_USER=${secret.mysql_user}
export MYSQL_PASSWORD=${secret.mysql_password}
export MYSQL_ROOT_PASSWORD=${secret.mysql_root_password}
`;
            fs.writeFile('/data/nextcloud-aws/secrets.sh', fileContent, (err) => {
                if (err) throw err;
                console.log('/data/nextcloud-aws/secrets.sh file successfully created');
            });
        } 
    }

    // Your code goes here.
});