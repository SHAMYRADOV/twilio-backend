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

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  return null;
}

app.get('/test-auth', async (req, res) => {
  try {
    const balance = await client.api.v2010.accounts(TWILIO_SID).fetch();
    res.json({ success: true, status: 'Authenticated', sid: balance.sid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    // console.log('📦 Items:', JSON.stringify(items, null, 2));


    for (const item of items) {
      const name = item.name;
      const phoneField = item.column_values.find(c => c.id === 'text_mkpfez9j'); // Replace with actual phone column ID
      const rawPhone = phoneField?.text;
      const phone = normalizePhone(rawPhone);
      if (!phone) continue;
      const personalized = message.replaceAll('{name}', name);

      try {
        await client.messages.create({
          from: TWILIO_FROM,
          to: phone,
          body: personalized,
          mediaUrl: imageUrl ? [imageUrl] : undefined,
        });

        console.log(`✅ Message sent to ${name} at ${phone}`);
        results.push({ name, phone, status: 'sent' });
      } catch (err) {
        console.log(`❌ Failed to send to ${name} at ${phone}: ${err.message}`);
        results.push({ name, phone, status: 'failed', error: err.message });
      }
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



// import express from 'express';
// import dotenv from 'dotenv';
// import cors from 'cors';
// import twilio from 'twilio';

// dotenv.config();

// const app = express();
// app.use(cors());
// app.use(express.json());

// const PORT = process.env.PORT || 3001;

// const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
// const TWILIO_FROM = process.env.TWILIO_FROM;

// app.post('/send-messages', async (req, res) => {
//   const { message, imageUrl } = req.body;

//   // ✅ Manually test with fixed name and number
//   const testName = "John";
//   const testPhone = +17703700671; // Replace with your real test number

//   try {
//     await client.messages.create({
//       from: TWILIO_FROM,
//       to: testPhone,
//       body: `Hi ${testName}, ${message}`,
//       mediaUrl: imageUrl ? [imageUrl] : undefined,
//     });

//     console.log(`✅ Sent to ${testName} at ${testPhone}`);
//     res.json({ success: true, sentTo: testPhone });
//   } catch (err) {
//     console.error('❌ Twilio Error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   }
// });

// app.listen(PORT, () => {
//   console.log(`✅ Backend running on http://localhost:${PORT}`);
// });
