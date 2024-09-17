// @ts-ignore
import config from "../config.js";

const systemPrompt = `You are an API for expaning text, while maintaining the original style, tone, and meaning. The original text represents one "chunk" of content at a given level-of-detail, and your job is to return a few "chunks" of expanded content. This is for a structured text editor, that allows the user to progressively add more details in "layers".`

const toolInfo = {
  "tool_choice": {"type": "tool", "name": "expand-text"},
  "tools": [
    { "name": "expand-text"
      , "description": "Return an expanded version of the input text, maintaining the original style, tone, and meaning. The expanded text should be roughly 2 to 3 times longer than the input. The expanded text should be split into meaningful 'chunks'. The chunks should be roughly equal in length, and returns as an array of strings. If the content is fiction, you may add new elements and ideas that were not present in the original. If the content is non-fiction, you may add more details but try to stick to the original content more closely. In either case, DO NOT EXCEED three times the original length, even if keeping it short would lose out some details."
      , "input_schema": {"type": "object", "properties": {"output": {"type": "array", "items": {"type": "string"}}}}
    }
  ]
}

type UserMessage = {"role": "user", "content": [{"type":"text", "text": string}]};

function userMessage(text: string) : UserMessage {
  return {"role": "user", "content": [{"type":"text", "text": text}]};
}

export default async function getExpanded(input : string) {
  const msg = {
    model: "claude-3-5-sonnet-20240620",
    max_tokens: 4096,
    temperature: 0.5,
    system: systemPrompt,
    messages: [userMessage(input)],
    ...toolInfo
  };

  const req = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': config.ANTHROPIC_API_KEY
    },
    body: JSON.stringify(msg),
  };

  console.log('req', req);

  const response = await fetch('https://api.anthropic.com/v1/messages', req);

  const data = await response.json();

  if (data.stop_reason === 'tool_use') {
    return data.content[0].input.output;
  } else {
    throw new Error('Unexpected response from Anthropic', data);
  }
}