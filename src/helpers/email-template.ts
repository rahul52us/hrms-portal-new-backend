import handlebars from 'handlebars';
import mjml2html from 'mjml';
import fs from 'fs';
import path from 'path';

type Props = {
  fileName: string;
  data: {
    date?: string;
    name?: string;
    url?: string;
    teamName?: string;
    link?: string;
    workflow_name?:string;
    password?:string;
    username?:string;
    level?:string;
    role?:string;
    designation?:string;
    verifyTokenUrl?:string
  }
};

export default async function compileEmailTemplate({ fileName, data }: Props): Promise<string> {
  const mjMail = await fs.promises.readFile(path.join('src/email-templates', fileName), 'utf8');
  const template = handlebars.compile(mjMail)(data);
  return mjml2html(template).html.toString();
}
