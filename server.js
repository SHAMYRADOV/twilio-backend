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
  const startTime = Date.now();

  if (!message && !imageUrl) {
    return res.status(400).json({ success: false, error: 'Message or image is required.' });
  }

  try {
    console.log('📞 Starting campaign...');
    
    // Fetch contractors from Monday.com
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
    console.log(`📋 Fetched ${items.length} contractors from Monday.com`);

    // Extract and deduplicate phone numbers
    const contactsMap = new Map(); // Use Map to track duplicates
    let duplicateCount = 0;

    for (const item of items) {
      const name = item.name;
      const phoneField = item.column_values.find(c => c.id === 'text_mkpfez9j');
      const rawPhone = phoneField?.text;
      const phone = normalizePhone(rawPhone);
      
      if (!phone) continue;

      // Remove all non-digit characters for duplicate detection
      const phoneKey = phone.replace(/\D/g, '');
      
      if (contactsMap.has(phoneKey)) {
        duplicateCount++;
        console.log(`🔄 Duplicate found: ${rawPhone} (${name}) - skipping`);
      } else {
        contactsMap.set(phoneKey, { name, phone, rawPhone });
      }
    }

    const uniqueContacts = Array.from(contactsMap.values());
    console.log(`✅ Unique contacts: ${uniqueContacts.length}`);
    console.log(`🔄 Duplicates removed: ${duplicateCount}`);

    // Batch configuration
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 2000; // 2 seconds between batches
    const results = [];
    let successCount = 0;
    let failureCount = 0;

    // Process in batches
    for (let i = 0; i < uniqueContacts.length; i += BATCH_SIZE) {
      const batch = uniqueContacts.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(uniqueContacts.length / BATCH_SIZE);
      
      console.log(`📦 Processing batch ${batchNumber}/${totalBatches} (${batch.length} messages)`);

      // Send all messages in current batch in parallel
      const batchPromises = batch.map(async (contact) => {
        const { name, phone, rawPhone } = contact;
        const personalized = message.replaceAll('{name}', name);

        try {
          const result = await client.messages.create({
            from: TWILIO_FROM,
            to: phone,
            body: personalized,
            mediaUrl: imageUrl ? [imageUrl] : undefined,
          });

          console.log(`✅ Sent to ${name} (${phone}) - SID: ${result.sid}`);
          successCount++;
          return { name, phone: rawPhone, status: 'sent', sid: result.sid, twilioStatus: result.status };
        } catch (err) {
          console.log(`❌ Failed: ${name} (${phone}) - ${err.message}`);
          failureCount++;
          return { name, phone: rawPhone, status: 'failed', error: err.message, code: err.code };
        }
      });

      // Wait for all messages in batch to complete
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Delay before next batch (except for the last batch)
      if (i + BATCH_SIZE < uniqueContacts.length) {
        console.log(`⏳ Waiting ${BATCH_DELAY_MS / 1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const endTime = Date.now();
    const durationSeconds = Math.round((endTime - startTime) / 1000);
    
    console.log('🎉 Campaign complete!');
    console.log(`✅ Success: ${successCount}`);
    console.log(`❌ Failed: ${failureCount}`);
    console.log(`⏱️  Duration: ${durationSeconds}s`);

    res.json({ 
      success: true, 
      results,
      summary: {
        totalContacts: items.length,
        duplicatesRemoved: duplicateCount,
        uniqueContacts: uniqueContacts.length,
        successCount,
        failureCount,
        durationSeconds
      }
    });
  } catch (err) {
    console.error('❌ Campaign Error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
