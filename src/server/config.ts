import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  markdownDir: path.resolve(process.env.MARKDOWN_DIR || './test/fixtures/sample-vault'),
  port: parseInt(process.env.PORT || '3000', 10),
};
