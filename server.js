const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const sharp = require('sharp');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload({
  createParentPath: true,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
}));
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
});

// Initialize database
db.serialize(() => {
  db.run('DROP TABLE IF EXISTS files'); // Clean start
  
  db.run(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('Error creating table:', err);
    else console.log('Table created successfully');
  });
});

// File storage setup
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const THUMBNAILS_DIR = path.join(__dirname, 'thumbnails');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });

// File upload endpoint
app.post('/upload', async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ error: 'No files were uploaded' });
    }

    const files = Array.isArray(req.files.files) ? req.files.files : [req.files.files];
    const uploadResults = [];

    for (const file of files) {
      try {
        const fileExt = path.extname(file.name).toLowerCase().substring(1);
        const originalName = file.name;
        const storedName = `${Date.now()}.${fileExt}`;
        const uploadPath = path.join(UPLOADS_DIR, storedName);

        await file.mv(uploadPath);

        // Generate thumbnail for supported image types
        let thumbnailPath = null;
        if (['jpg','jpeg','png','gif','webp'].includes(fileExt)) {
          thumbnailPath = path.join(THUMBNAILS_DIR, storedName);
          await sharp(uploadPath)
            .resize(300, 300, { 
              fit: 'inside', 
              withoutEnlargement: true 
            })
            .toFile(thumbnailPath);
        }

        const { lastID } = await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO files (original_name, stored_name, path, type, size) 
             VALUES (?, ?, ?, ?, ?)`,
            [originalName, storedName, uploadPath, fileExt, file.size],
            function(err) {
              if (err) reject(err);
              else resolve(this);
            }
          );
        });

        uploadResults.push({
          id: lastID,
          name: originalName,
          type: fileExt,
          size: file.size,
          url: `/files/${lastID}`,
          thumbnailUrl: thumbnailPath ? `/thumbnails/${lastID}` : null
        });
      } catch (fileError) {
        console.error('Error processing file:', file.name, fileError);
        uploadResults.push({
          name: file.name,
          error: fileError.message
        });
      }
    }

    res.json({ 
      success: true,
      results: uploadResults
    });
  } catch (error) {
    console.error('Upload endpoint error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// Get files list
app.get('/files', (req, res) => {
  db.all(
    `SELECT id, original_name as name, type, size FROM files ORDER BY uploaded_at DESC`,
    (err, files) => {
      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      // Add thumbnail URLs to response
      const filesWithThumbnails = files.map(file => ({
        ...file,
        thumbnailUrl: ['jpg','jpeg','png','gif','webp'].includes(file.type) 
          ? `/thumbnails/${file.id}` 
          : null
      }));
      
      res.json(filesWithThumbnails);
    }
  );
});

// Get original file
app.get('/files/:id', (req, res) => {
  const fileId = req.params.id;
  
  db.get(
    `SELECT original_name, stored_name, path FROM files WHERE id = ?`,
    [fileId],
    (err, file) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).send('Database error');
      }
      if (!file) {
        return res.status(404).send('File not found');
      }
      
      if (!fs.existsSync(file.path)) {
        return res.status(404).send('File missing from storage');
      }

      res.download(file.path, file.original_name);
    }
  );
});

// Get thumbnail
app.get('/thumbnails/:id', (req, res) => {
  const fileId = req.params.id;
  
  db.get(
    `SELECT stored_name, type FROM files WHERE id = ?`,
    [fileId],
    (err, file) => {
      if (err || !file) {
        return res.status(404).send('File not found');
      }
      
      if (!['jpg','jpeg','png','gif','webp'].includes(file.type)) {
        return res.status(400).send('Thumbnail not available for this file type');
      }

      const thumbnailPath = path.join(THUMBNAILS_DIR, file.stored_name);
      
      if (!fs.existsSync(thumbnailPath)) {
        return res.status(404).send('Thumbnail not found');
      }

      res.sendFile(thumbnailPath);
    }
  );
});

// Delete file
app.delete('/files/:id', async (req, res) => {
  try {
    const file = await new Promise((resolve, reject) => {
      db.get(
        `SELECT path, stored_name FROM files WHERE id = ?`,
        [req.params.id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete original file
    if (fs.existsSync(file.path)) {
      await fs.promises.unlink(file.path);
    }

    // Delete thumbnail if exists
    const thumbnailPath = path.join(THUMBNAILS_DIR, file.stored_name);
    if (fs.existsSync(thumbnailPath)) {
      await fs.promises.unlink(thumbnailPath);
    }

    // Delete database record
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM files WHERE id = ?', [req.params.id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on:
  - Local: http://localhost:${PORT}
  - Network: http://${getLocalIpAddress()}:${PORT}`);
});

function getLocalIpAddress() {
  const interfaces = require('os').networkInterfaces();
  for (const interfaceName in interfaces) {
    for (const iface of interfaces[interfaceName]) {
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return 'localhost';
}