const express = require("express");
const path = require("path");
const fs = require("fs");
const https = require("https");
const multer = require("multer");
// Create analysis folder if it doesn't exist
if (!fs.existsSync("analysis")) {
  fs.mkdirSync("analysis");
}

// Create uploads folder if it doesn't exist
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// Configure multer for multipart/form-data file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

const app = express();
const PORT = process.env.PORT || 3000;

function httpsPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);

    // Convert data to string if it's not already
    const postData = typeof data === "string" ? data : JSON.stringify(data);

    const requestOptions = {
      hostname: options.hostname,
      path: options.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        ...headers,
      },
    };

    const req = https.request(requestOptions, (res) => {
      let responseData = "";

      // Handle HTTP status codes
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Status Code: ${res.statusCode}`));
      }

      // Receive data in chunks
      res.on("data", (chunk) => {
        responseData += chunk;
      });

      // When the entire response has been received
      res.on("end", () => {
        try {
          // Parse the data as JSON
          const parsedData = JSON.parse(responseData);
          resolve(parsedData);
        } catch (e) {
          // If it's not JSON, return the raw data
          resolve(responseData);
        }
      });
    });

    // Handle connection errors
    req.on("error", (error) => {
      reject(error);
    });

    // Handle timeout
    req.setTimeout(100000, () => {
      req.destroy();
      reject(new Error("Request time out"));
    });

    // Write data to request body
    req.write(postData);
    req.end();
  });
}

// Middleware to handle errors
const handleErrors = (fn) => {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      console.error("Error:", error);
      res.status(500).send("Internal Server Error");
    }
  };
};
const pdfParse = require("pdf-parse");

async function callAnthropic(prompt, files) {
  try {
    const url = "https://api.anthropic.com/v1/messages";

    const headers = {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    // If files exist, map each file to a message
    const fileMessages = files
      ? await Promise.all(
          files.map(async (file) => {
            // Add PDF parsing logic
            const dataBuffer = fs.readFileSync(file.path);

            return new Promise((resolve) => {
              pdfParse(dataBuffer).then((data) => {
                resolve(data.text);
              });
            });
          }),
        )
      : []; // Empty array if no files

    const fullprompt =
      prompt + "\n\nInput document appel d'offres:" + fileMessages.join("\n\n");

    console.log(fullprompt);
    const data = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: fullprompt,
            },
          ],
        },
      ],
    };

    const response = await httpsPost(url, data, headers);
    return response.content[0].text;
  } catch (error) {
    console.error("Error:", error.message);
    throw error;
  }
}

// Serve static files from the analysis directory
app.use("/analysis", express.static(path.join(__dirname, "analysis")));

// Route to list all HTML files in the analysis directory
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/gen", async (req, res) => {
  try {
    const preprompt = fs.readFileSync("descriptionsite.txt").toString();
    const response = await callAnthropic(preprompt);
    console.log("Claude response:", response);

    // Generate random filename
    const filename = Math.random().toString(36).substring(7) + ".html";
    const filepath = path.join(__dirname, "analysis", filename);

    // Write response to HTML file
    const htmlContent = response;

    fs.writeFileSync(filepath, htmlContent);

    // Redirect to the new file
    res.redirect(`/analysis/${filename}`);
  } catch (error) {
    console.error("Main error:", error);
    res.status(500).send("Error generating response");
  }
});

// Express route to handle multipart file uploads
app.post("/gen", upload.array("files"), async (req, res) => {
  try {
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const preprompt = fs.readFileSync("descriptionsite.txt").toString();
    const response = await callAnthropic(preprompt, files);

    // Generate random filename for the HTML response
    const filename = Math.random().toString(36).substring(7) + ".html";
    const filepath = path.join(__dirname, "analysis", filename);

    // Write response to HTML file
    fs.writeFileSync(filepath, response);

    // Cleanup uploaded files
    files.forEach((file) => {
      fs.unlinkSync(file.path);
    });

    // Return the filename of the generated HTML
    res.json({
      success: true,
      filename: filename,
      url: `/analysis/${filename}`,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Serving HTML files from: ${path.join(__dirname, "analysis")}`);
});
