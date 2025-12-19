require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const BOARD_ID = process.env.BOARD_ID;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

const client = twilio(TWILIO_SID, TWILIO_AUTH);

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

console.log('Twilio config:', TWILIO_SID, TWILIO_AUTH, TWILIO_FROM);

app.get('/test-auth', async (req, res) => {
  try {
    const balance = await client.api.v2010.accounts(TWILIO_SID).fetch();
    res.json({ success: true, status: 'Authenticated', sid: balance.sid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🧪 TEST ENDPOINT: Send to a single phone number directly
app.post('/test-send', async (req, res) => {
  const { phone, message } = req.body;
  
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Phone and message required' });
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return res.status(400).json({ success: false, error: 'Invalid phone format' });
  }

  try {
    console.log(`🧪 TEST: Sending to ${normalizedPhone} from ${TWILIO_FROM}`);
    const result = await client.messages.create({
      from: TWILIO_FROM,
      to: normalizedPhone,
      body: message,
    });

    console.log(`✅ TEST SUCCESS - SID: ${result.sid}, Status: ${result.status}`);
    res.json({ 
      success: true, 
      sid: result.sid, 
      status: result.status,
      to: result.to,
      from: result.from
    });
  } catch (err) {
    console.log(`❌ TEST FAILED - Code: ${err.code}, Message: ${err.message}`);
    console.log('Full error:', JSON.stringify(err, null, 2));
    res.status(500).json({ 
      success: false, 
      error: err.message,
      code: err.code,
      moreInfo: err.moreInfo
    });
  }
});

app.post('/send-messages', async (req, res) => {
  const { message, imageUrl } = req.body;
  const results = [];

  if (!message && !imageUrl) {
    return res.status(400).json({ success: false, error: 'Message or image is required.' });
  }

  try {
    const query = `
      query {
        boards(ids: "${BOARD_ID}") {
          items_page {
            items {
              name
              column_values {
                id
                text
              }
            }
          }
        }
      }
    `;

    const mondayRes = await axios.post(
      'https://api.monday.com/v2',
      { query },
      {
        headers: {
          Authorization: MONDAY_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const items = mondayRes.data.data.boards[0].items_page.items;

    for (const item of items) {
      const name = item.name;
      const phoneField = item.column_values.find(c => c.id === 'text_mkpfez9j'); // Replace with your phone column ID
      const rawPhone = phoneField?.text;
      const phone = normalizePhone(rawPhone);
      if (!phone) continue;

      const personalized = message.replaceAll('{name}', name);

      try {
        const result = await client.messages.create({
          from: TWILIO_FROM,
          // messagingServiceSid: 'MGdec68ad262c8c24a4c4bff18a23ecd32',
          to: phone,
          body: personalized,
          mediaUrl: imageUrl ? [imageUrl] : undefined,
        });

        console.log(`✅ Message sent to ${name} at ${phone}`);
        console.log(`📱 Twilio SID: ${result.sid}, Status: ${result.status}`);
        results.push({ name, phone, status: 'sent', sid: result.sid, twilioStatus: result.status });
      } catch (err) {
        console.log(`❌ Failed to send to ${name} at ${phone}`);
        console.log(`❌ Error Code: ${err.code}, Message: ${err.message}`);
        console.log(`❌ Full Error:`, JSON.stringify(err, null, 2));
        results.push({ name, phone, status: 'failed', error: err.message, code: err.code });
      }

      // 🕐 1-second delay between each message
      await new Promise(res => setTimeout(res, 1000));
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('❌ Error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
