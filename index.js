const express = require('express')
const Imap = require('node-imap')
const fs = require('fs')
const morgan = require('morgan')
const app = express()

app.use(morgan('combined'))
// Define regular expressions to extract email headers
const regexFrom = /^From: (.*)$/m
const regexTo = /^To: (.*)$/m
const regexSubject = /^Subject: (.*)$/m
const regexDate = /^Date: (.*)$/m

//load credential from .env
require('dotenv').config()

const EMAIL = process.env.EMAIL
const PASSWORD = process.env.PASSWORD
const HOST = process.env.HOST
const PORT = process.env.PORT
const TLS = process.env.TLS
const KEY = process.env.KEY

const port = process.env.API_PORT || 3000

/**
 * Parses the body of an email message and returns an object with selected headers
 *
 * @param {string} body - The message body to parse
 * @returns {Object} An object containing selected message headers
 */
function parseMessageBody(body) {
  const fromMatch = body.match(regexFrom)
  const toMatch = body.match(regexTo)
  const subjectMatch = body.match(regexSubject)
  const dateMatch = body.match(regexDate)

  // extract mail content starting after X-Rspamd-Queue-Id if present
  let queueIdIndex = body.indexOf('X-Rspamd-Queue-Id:')
  let mailContent = ''
  if (queueIdIndex !== -1) {
    mailContent = body.substring(queueIdIndex)
  }

  return {
    from: fromMatch ? fromMatch[1].trim() : '',
    to: toMatch ? toMatch[1].trim() : '',
    subject: subjectMatch ? subjectMatch[1].trim() : '',
    date: dateMatch ? dateMatch[1].trim() : '',
    mailContent: mailContent,
  }
}

app.get('/inbox', async (req, res) => {
  const key = req.query.key
  const email = req.query.email
  if (key !== KEY) {
    return res.status(401).json({
      success: false,
      status: 'error',
      message: 'Unauthorized',
    })
  }
  const domain = email.split('@')[1]
  // check if domain exist on file domainlist.txt, if not return success false
  const domainList = fs.readFileSync('domainlist.txt', 'utf8')
  if (!domainList.includes(domain)) {
    return res.status(400).json({
      success: false,
      status: 'error',
      message: `Domain ${domain} not found on domainlist.txt, check /domainlist?key=key for available domain`,
    })
  }
  // extract email address from URL query parameter

  // create new IMAP instance with connection settings
  const imap = new Imap({
    user: EMAIL,
    password: PASSWORD,
    host: HOST,
    port: PORT,
    tls: TLS,
    tlsOptions: { rejectUnauthorized: false },
  })

  // connect to server and authenticate user
  await new Promise((resolve, reject) => {
    imap.once('ready', resolve)
    imap.once('error', reject)
    imap.connect()
  })
    .then(() => {
      // open the INBOX mailbox
      imap.openBox('INBOX', true, (err, box) => {
        if (err) throw err

        // search for messages sent to specified email address
        imap.search(['ALL', ['TO', email]], (err, uids) => {
          // if the uids array is empty, return an empty array of messages
          if (uids.length === 0) {
            res.status(200).json({
              success: true,
              email: email,
              messages: [],
            })
            return
          }
          if (err) throw err

          // fetch messages with specified UID values
          const f = imap.fetch(uids, {
            bodies: '',
            markSeen: true,
          })

          const messages = []

          f.on('message', (msg, seqno) => {
            let message = {}

            msg.on('body', (stream, info) => {
              let buffer = ''

              stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8')
              })

              stream.once('end', () => {
                message = { ...message, body: buffer }
              })
            })

            msg.once('attributes', (attrs) => {
              message = { ...message, attrs }
            })

            msg.once('end', () => {
              // parse message body into selected headers using regular expressions
              const parsedBody = parseMessageBody(message.body)

              // add parsed headers to message object
              message = { ...message, ...parsedBody }

              messages.push(message)
            })
          })

          f.once('error', (err) => {
            console.error(err)

            // end connection with IMAP server
            imap.end()

            res.status(500).json({
              success: false,
              error: err.message,
            })

            return
          })

          f.once('end', () => {
            // format fetched messages as JSON and send as response
            res.status(200).json({
              success: true,
              email: email,
              messages: messages
                .sort((a, b) => new Date(b.date) - new Date(a.date)) // Sort messages in descending order of date
                .map((message) => {
                  // Extract mail content string after removing X-Rspamd-Queue-Id header
                  let mailContent = message.mailContent
                  const queueIdIndex = mailContent.indexOf('X-Rspamd-Queue-Id:')
                  if (queueIdIndex !== -1) {
                    const nextLineIndex = mailContent.indexOf(
                      '\r\n',
                      queueIdIndex
                    )
                    mailContent =
                      mailContent.substring(0, queueIdIndex) +
                      mailContent.substring(nextLineIndex + 2)
                  }

                  // Find the index of the Content-Type header and extract the remaining string
                  const contentTypeIndex = mailContent.indexOf('Content-Type:')
                  const contentTypeValue =
                    contentTypeIndex !== -1
                      ? mailContent.substring(contentTypeIndex)
                      : 'N/A'

                  return {
                    from: message.from,
                    to: message.to,
                    subject: message.subject,
                    date: message.date,
                    mailContent: contentTypeValue,
                  }
                }),
            })

            // end connection with IMAP server
            imap.end()
          })
        })
      })
    })
    .catch((err) => {
      console.error(err)

      res.status(500).json({
        success: false,
        error: err.message,
      })

      return
    })
})

app.get('/domainList', async (req, res) => {
  try {
    const key = req.query.key
    if (key !== KEY) {
      return res.status(401).json({
        success: false,
        status: 'error',
        message: 'Unauthorized',
      })
    }
    //read file domainlist.txt and return as json array of domains
    const data = fs.readFileSync('domainlist.txt', 'utf8')
    let domains = data.split('\n')
    //remove empty string from array
    domains = domains.filter((domain) => domain !== '')
    res.status(200).json({
      success: true,
      domainList: domains,
    })
  } catch (err) {
    console.error(err)

    res.status(500).json({
      success: false,
      error: err.message,
    })
  }
})

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`)
})
