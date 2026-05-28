const OpenAI = require("openai");
import { config } from "dotenv";
config()
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
