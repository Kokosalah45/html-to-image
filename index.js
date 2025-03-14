const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const ejs = require('ejs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

// Determine the number of CPU cores to use (using 75% of available cores)
const NUM_WORKERS = Math.max(1, Math.floor(os.cpus().length * 0.75));

// Main thread code
if (isMainThread) {
  // Read products from file instead of importing
  const productsFilePath = path.join(__dirname, 'products.json');
  let productsData = [];
  
  try {
    const productsJson = fs.readFileSync(productsFilePath, 'utf8');
    productsData = JSON.parse(productsJson);
    console.log(`Loaded ${productsData.length} products from ${productsFilePath}`);
  } catch (error) {
    console.error(`Error reading products file: ${error.message}`);
    process.exit(1);
  }
  
  // Setup directories
  const outputDir = path.join(__dirname, 'generated_cards');
  const imagesDir = path.join(__dirname, 'images');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Created output directory at ${outputDir}`);
  }

  // Ensure images directory exists
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
    console.log(`Created images directory at ${imagesDir}`);
  }

  // HTML template as a string
  const htmlTemplate = `
  <!DOCTYPE html>
  <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>بطاقة المنتج</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
          font-family: 'Arial', sans-serif;
        }
        
        body {
          background-color: white;
          margin: 0;
          padding: 0;
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          display: grid;
          place-items: center;
        }
        
        .product-card {
          width: 100dvw;
          height: 100dvh;
          position: relative;
          overflow: hidden;
          background: transparent;
          border-radius: 10px;
        }
        
        .product-image {
          width: 100%;
          height: 100%;
          position: relative;
        }
        
        .product-image img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
        
        /* Larger circular price tag with rotation */
        .price-circle {
          position: absolute;
          top: 200px;
          right: 30px;
          width: 150px;
          height: 150px;
          background-color: black;
          border: 5px solid white;
          border-radius: 50%;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          color: white;
          font-weight: bold;
          z-index: 10;
          box-shadow: 0 6px 12px rgba(0, 0, 0, 0.4);
          transform: rotate(30deg);
        }
        
        .price-value {
          font-size: 36px;
          line-height: 1;
          margin-bottom: 4px;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        }
        
        .price-currency {
          font-size: 24px;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        }
      </style>
    </head>
    <body>
      <div class="product-card">
        <div class="product-image">
          <img src="<%= imageUrl %>" alt="صورة المنتج" />
          <div class="price-circle">
            <div class="price-value"><%= priceInArabic %></div>
          </div>
        </div>
      </div>
    </body>
  </html>
  `;

  // Function to convert western digits to Arabic digits
  function convertToArabicDigits(num) {
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return num.toString().replace(/\d/g, match => arabicDigits[match]);
  }

  // Filter products that need image generation (different prices)
  const productsToProcess = productsData.filter(product => {
    // If previous_price is null or undefined, or different from current_price, generate an image
    return product.previous_price === null || 
           product.previous_price === undefined || 
           product.previous_price !== product.current_price;
  });

  console.log(`Found ${productsToProcess.length} products with price changes that need image generation`);

  // Start the server
  async function startServer() {
    return new Promise((resolve) => {
      const app = express();
      
      // Serve static files from the current directory and images directory
      app.use(express.static(__dirname));
      app.use('/images', express.static(imagesDir));
      
      // Add route to render dynamic template
      app.get('/product/:index', (req, res) => {
        const productIndex = parseInt(req.params.index);
        if (isNaN(productIndex) || productIndex < 0 || productIndex >= productsData.length) {
          return res.status(404).send('Product not found');
        }
        
        const product = productsData[productIndex];
        
        // Determine image filename based on product code and variation suffix
        let imageFileName;
        if (product.variation_suffix) {
          imageFileName = `${product.productCode}_${product.variation_suffix}.jpg`;
        } else {
          imageFileName = `${product.productCode}.jpg`;
        }
        
        // Format price with two decimal places and convert to Arabic digits
        const price = product.current_price.toFixed(2);
        const priceInArabic = convertToArabicDigits(price);
        
        // Render the template with the product data
        res.send(ejs.render(htmlTemplate, {
          imageUrl: `/images/${imageFileName}`,
          priceInArabic: priceInArabic
        }));
      });

      // Create HTTP server
      const server = http.createServer(app);
      const port = 3000;
      
      // Start the server
      server.listen(port, () => {
        console.log(`Server running at http://localhost:${port}/`);
        resolve(server);
      });
    });
  }

  // Divide products into chunks for each worker
  function chunkArray(array, chunkCount) {
    const chunks = Array(chunkCount).fill().map(() => []);
    array.forEach((item, index) => {
      const chunkIndex = index % chunkCount;
      chunks[chunkIndex].push({
        index: productsData.findIndex(p => 
          p.productCode === item.productCode && 
          (p.variation_suffix === item.variation_suffix || 
          (!p.variation_suffix && !item.variation_suffix))
        ),
        product: item
      });
    });
    return chunks;
  }

  // Main function
  async function main() {
    // If no products need processing, exit early
    if (productsToProcess.length === 0) {
      console.log("No product price changes detected. No images need to be generated.");
      return;
    }
    
    console.log(`Starting with ${NUM_WORKERS} worker threads`);
    
    // Start the server
    const server = await startServer();
    
    // Split products into chunks
    const productChunks = chunkArray(productsToProcess, NUM_WORKERS);
    
    // Create and track workers
    const workers = [];
    let completedWorkers = 0;
    
    // Create a promise that resolves when all workers are done
    const workerPromise = new Promise((resolve) => {
      for (let i = 0; i < NUM_WORKERS; i++) {
        if (productChunks[i].length === 0) continue;
        
        const worker = new Worker(__filename, {
          workerData: {
            productChunk: productChunks[i],
            outputDir,
            serverPort: 3000
          }
        });
        
        worker.on('message', (message) => {
          console.log(`Worker ${i+1} says: ${message}`);
          if (message === 'DONE') {
            completedWorkers++;
            if (completedWorkers === workers.length) {
              resolve();
            }
          }
        });
        
        worker.on('error', (err) => {
          console.error(`Worker ${i+1} error:`, err);
        });
        
        workers.push(worker);
      }

      // If no workers were created (empty chunks), resolve immediately
      if (workers.length === 0) {
        resolve();
      }
    });
    
    // Wait for all workers to complete
    await workerPromise;
    
    // Shutdown server
    server.close(() => {
      console.log('Server closed');
    });
    
    console.log(`Successfully generated ${productsToProcess.length} product card images in ${outputDir}`);
    
    // Update the JSON file to set previous_price equal to current_price
    const updatedProducts = productsData.map(product => {
      return {
        ...product,
        previous_price: product.current_price
      };
    });
    
    // Write the updated products back to the file
    fs.writeFileSync(productsFilePath, JSON.stringify(updatedProducts, null, 2), 'utf8');
    console.log(`Updated products.json file with new previous_price values`);
  }
  
  // Run the main function
  main().catch(console.error);
}
// Worker thread code
else {
  (async () => {
    try {
      const { productChunk, outputDir, serverPort } = workerData;
      
      // Launch the browser
      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      try {
        // Create a new page
        const page = await browser.newPage();
        
        // Set viewport size
        await page.setViewport({
          width: 1368,
          height: 768,
          deviceScaleFactor: 2 // Higher resolution
        });

        // Process each product in the chunk
        for (let i = 0; i < productChunk.length; i++) {
          const { index, product } = productChunk[i];
          
          // Send status message to main thread
          parentPort.postMessage(`Processing product ${index+1}: Product Code ${product.productCode}${product.variation_suffix ? '_' + product.variation_suffix : ''}`);
          
          // Navigate to the product page
          await page.goto(`http://localhost:${serverPort}/product/${index}`, {
            waitUntil: 'networkidle0' // Wait until all resources are loaded
          });
          
          // Determine output filename
          let outputFileName;
          if (product.variation_suffix) {
            outputFileName = `${product.productCode}_${product.variation_suffix}.webp`;
          } else {
            outputFileName = `${product.productCode}.webp`;
          }
          
          const outputPath = path.join(outputDir, outputFileName);
          
          // Take a screenshot
          await page.screenshot({
            path: outputPath,
            fullPage: true,
            omitBackground: true,
            type: 'webp'
          });
          
          parentPort.postMessage(`Generated image: ${outputPath}`);
        }
      } finally {
        // Close the browser
        await browser.close();
      }
      
      // Signal completion to main thread
      parentPort.postMessage('DONE');
    } catch (error) {
      console.error('Worker error:', error);
      parentPort.postMessage(`Error: ${error.message}`);
      process.exit(1);
    }
  })();
}