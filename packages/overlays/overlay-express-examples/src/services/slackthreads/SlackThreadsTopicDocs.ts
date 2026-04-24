export default `
# SlackThread Topic Manager Documentation

The **SlackThread Topic Manager** (topic ID: \`tm_slackthread\`) lets clients Push hashes to chain and remove them by revealing the preimage.

Either there is a locking script of the form:

\`\`\`asm
OP_SHA256 <32 byte hash> OP_EQUAL
\`\`\`
or something which spends one of those locking scripts, with a preimage of any form in the unlocking script.

`
