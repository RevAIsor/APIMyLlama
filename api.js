const { getOllamaURL, sendWebhookNotification } = require('./utils');
const axios = require('axios');

const rateLimits = new Map();

function setupRoutes(app, db) {
  app.get('/health', (req, res) => healthCheck(req, res, db));
  app.use((req, res, next) => rateLimitMiddleware(req, res, next, db));
  app.post('/generate', (req, res) => generateResponse(req, res, db));
  app.post('/chat', (req, res) => chatResponse(req, res, db));
  app.post('/v1/chat/completions', (req, res) => openAIChatCompletions(req, res, db));
}

function extractBearerToken(authorizationHeader) {                         
  if (!authorizationHeader) return null;

  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  return trimmed.slice(7).trim();
}
function rateLimitMiddleware(req, res, next, db) {
  const apiKeyFromBody = req.body?.apikey;
  const apiKeyFromHeader = extractBearerToken(req.headers?.authorization);

  const apikey = apiKeyFromBody || apiKeyFromHeader;

  if (!apikey) {
      console.log("Blocked a request: Missing API Key");
      return res.status(400).json({ error: 'API key is required in the request body or Authorization header' });
  }

  req.apikey = apikey;

  db.get('SELECT tokens, last_used, rate_limit, active FROM apiKeys WHERE key = ?', [apikey], (err, row) => {
    if (err) {
      console.error('Error checking API key for rate limit:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (row) {
      if (row.active === 0) {
        return res.status(403).json({ error: 'API key is deactivated' });
      }

      const currentTime = Date.now();
      const minute = 60000;
      const rateLimit = row.rate_limit;

      if (!rateLimits.has(apikey)) {
        rateLimits.set(apikey, { tokens: row.tokens, lastUsed: new Date(row.last_used).getTime() });
      }

      const rateLimitInfo = rateLimits.get(apikey);
      const timeElapsed = currentTime - rateLimitInfo.lastUsed;

      if (timeElapsed >= minute) {
        rateLimitInfo.tokens = rateLimit;
      }

      if (rateLimitInfo.tokens > 0) {
        rateLimitInfo.tokens -= 1;
        rateLimitInfo.lastUsed = currentTime;
        rateLimits.set(apikey, rateLimitInfo);

        db.run('UPDATE apiKeys SET tokens = ?, last_used = ? WHERE key = ?', [rateLimitInfo.tokens, new Date(rateLimitInfo.lastUsed).toISOString(), apikey], (err) => {
          if (err) {
            console.error('Error updating tokens and last_used:', err.message);
            return res.status(500).json({ error: 'Internal server error' });
          }
          next();
        });
      } else {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      }
    } else {
      return res.status(403).json({ error: 'Invalid API key' });
    }
  });
}

function healthCheck(req, res, db) {
  const apikey = req.query.apikey;

  if (!apikey) {
    return res.status(400).json({ error: 'API key is required' });
  }

  db.get('SELECT key FROM apiKeys WHERE key = ?', [apikey], (err, row) => {
    if (err) {
      console.error('Error checking API key:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row) {
      console.log('Invalid API key');
      return res.status(403).json({ error: 'Invalid API Key' });
    }

    res.json({ status: 'API is healthy', timestamp: new Date() });
  });
}

async function generateResponse(req, res, db) {
  const {prompt, model, stream, images, format, system, raw } = req.body;
  const apikey = req.apikey;
  
  console.log('Request body:', { model, prompt, stream, images, format, system, raw });
  
  try {
    const ollamaURL = await getOllamaURL();
    const OLLAMA_API_URL = `${ollamaURL}/api/generate`;

    axios.post(OLLAMA_API_URL, { model, prompt, stream, images, format, system, raw })
      .then(response => {
        db.run('INSERT INTO apiUsage (key) VALUES (?)', [apikey], (err) => {
          if (err) console.error('Error logging API usage:', err.message);
        });

        sendWebhookNotification(db, { apikey, prompt, model, stream, images, format, system, raw, timestamp: new Date() });

        res.json(response.data);
      })
      .catch(error => {
        console.error('Error making request to Ollama API:', error.message);
        res.status(500).json({ error: 'Error making request to Ollama API' });
      });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error retrieving Ollama server port' });
  }
}

async function chatResponse(req, res, db) {
  const {model, messages, stream, format, options, tools} = req.body;
  const apikey = req.apikey;

  console.log('Chat request body:', req.body);

  try {
    const ollamaURL = await getOllamaURL();
    const OLLAMA_API_URL = `${ollamaURL}/api/chat`;

    axios.post(OLLAMA_API_URL, { model, messages, stream, format, options, tools })
      .then(response => {
        db.run('INSERT INTO apiUsage (key) VALUES (?)', [apikey], (err) => {
          if (err) console.error('Error logging API usage:', err.message);
        });

        sendWebhookNotification(db, { apikey, model, messages, stream, format, options, tools, timestamp: new Date() });

        res.json(response.data);
      })
      .catch(error => {
        console.error('Error making request to Ollama API:', error.message);
        res.status(500).json({ error: 'Error making request to Ollama API' });
      });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error retrieving Ollama server port' });
  }
}

async function openAIChatCompletions(req, res, db) {
  const apikey = req.apikey;
  const { apikey: _, ...requestBody } = req.body;

  console.log('OpenAI-compatible chat completions request:', { model: req.body.model, messages: req.body.messages?.length });

  try {
    const ollamaURL = await getOllamaURL();
    const OLLAMA_API_URL = `${ollamaURL}/v1/chat/completions`;

    axios.post(OLLAMA_API_URL, requestBody, {
      headers: { 'Content-Type': 'application/json' }
    })
      .then(response => {
        db.run('INSERT INTO apiUsage (key) VALUES (?)', [apikey], (err) => {
          if (err) console.error('Error logging API usage:', err.message);
        });

        sendWebhookNotification(db, { apikey, model: req.body.model, messages: req.body.messages, stream: req.body.stream, timestamp: new Date() });

        res.json(response.data);
      })
      .catch(error => {
        console.error('Error making request to Ollama API:', error.message);
        if (error.response) {
          res.status(error.response.status).json(error.response.data);
        } else {
          res.status(500).json({ error: 'Error making request to Ollama API' });
        }
      });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error retrieving Ollama server port' });
  }
}

module.exports = {
  setupRoutes
};