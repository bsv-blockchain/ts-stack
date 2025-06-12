export default `# Apps Topic Manager Documentation

The **Apps Topic Manager** defines which transaction outputs are
_admissible_ as on-chain app listings.

## Admissibility Rules

- The transaction must include at least one output.
- For an output to be admitted **all** of the following must hold:
  1. The locking script is a valid **PushDrop** script consisting of  
     exactly **one** data field **plus** its signature field.
  2. The data field decodes to valid app metadata.
  3. Required JSON properties are present and non-empty:  
     \`version\`, \`name\`, \`description\`, \`icon\`, \`domain\`,
     \`publisher\`, and \`release_date\`.
  4. At least one of **\`httpURL\`** _or_ **\`uhrpURL\`** is provided.
  5. Optional properties—\`short_name\`, \`category\`, \`tags\`,
     \`changelog\`, \`banner_image_url\`, \`screenshot_urls\`—may be
     included but are not validated beyond basic type checks.

Outputs failing any check are ignored and **not** admitted.
`