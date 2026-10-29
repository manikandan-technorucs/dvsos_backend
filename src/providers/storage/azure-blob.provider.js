const { 
  BlobServiceClient, 
  generateBlobSASQueryParameters, 
  BlobSASPermissions, 
  StorageSharedKeyCredential 
} = require('@azure/storage-blob');
const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { convertToOgg } = require('../../utils/audio-convert');

class AzureBlobProvider {
  constructor(config) {
    this.config = config;
    this.isConfigured = Boolean(config.connectionString && config.container);

    if (!this.isConfigured) {
      console.warn('Azure Blob storage provider is not configured yet.');
      return;
    }

    this.blobServiceClient = BlobServiceClient.fromConnectionString(config.connectionString);
    this.containerClient = this.blobServiceClient.getContainerClient(config.container);

    // Extract AccountName and AccountKey for offline SAS token generation
    const connStr = config.connectionString;
    const accountNameMatch = connStr.match(/AccountName=([^;]+)/);
    const accountKeyMatch = connStr.match(/AccountKey=([^;]+)/);
    this.accountName = accountNameMatch ? accountNameMatch[1] : null;
    this.accountKey = accountKeyMatch ? accountKeyMatch[1] : null;
  }

  async upload(filePath, options = {}) {
    if (!this.isConfigured) {
      throw new Error('Azure Blob storage provider is not configured.');
    }

    const extension = options.originalName ? path.extname(options.originalName) : path.extname(filePath);
    const uniqueName = uuidv4() + extension;
    const blobName = options.folder ? `${options.folder}/${uniqueName}` : uniqueName;

    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

    const mimeType = options.mimeType || 'application/octet-stream';
    const blobOptions = {
      blobHTTPHeaders: {
        blobContentType: mimeType
      }
    };

    const fileBuffer = await fs.readFile(filePath);
    await blockBlobClient.uploadData(fileBuffer, blobOptions);
    
    const size = options.size || fileBuffer.length;

    return {
      secure_url: blockBlobClient.url,
      url: blockBlobClient.url,
      public_id: blobName,
      format: extension.replace('.', '') || null,
      bytes: size
    };
  }

  async uploadBuffer(fileBuffer, options = {}) {
    if (!this.isConfigured) {
      throw new Error('Azure Blob storage provider is not configured.');
    }

    const extension = options.extension || (options.originalName ? path.extname(options.originalName) : '.webm');
    const uniqueName = uuidv4() + extension;
    const blobName = options.folder ? `${options.folder}/${uniqueName}` : uniqueName;

    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

    const mimeType = options.mimeType || 'audio/webm';
    const blobOptions = {
      blobHTTPHeaders: {
        blobContentType: mimeType
      }
    };

    await blockBlobClient.uploadData(fileBuffer, blobOptions);

    return {
      secure_url: blockBlobClient.url,
      url: blockBlobClient.url,
      public_id: blobName,
      format: extension.replace('.', '') || null,
      bytes: fileBuffer.length
    };
  }

  async uploadDataUrl(dataUrl, folder = 'voice-notes', options = {}) {
    if (!this.isConfigured) {
      throw new Error('Azure Blob storage provider is not configured.');
    }
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return null;
    }

    try {
      const commaIdx = dataUrl.indexOf(',');
      if (commaIdx === -1) {
        throw new Error('Invalid data URL format: missing comma separator');
      }

      const meta = dataUrl.substring(5, commaIdx);
      const base64Data = dataUrl.substring(commaIdx + 1).replace(/\s/g, '');
      const rawMimeType = meta.split(';')[0].toLowerCase().trim() || 'application/octet-stream';

      let mimeType = rawMimeType;
      let extension = options.extension || (options.fileName ? path.extname(options.fileName) : '');
      let buffer = Buffer.from(base64Data, 'base64');

      if (!extension) {
        if (rawMimeType.includes('jpeg') || rawMimeType.includes('jpg')) {
          mimeType = 'image/jpeg'; extension = '.jpg';
        } else if (rawMimeType.includes('png')) {
          mimeType = 'image/png'; extension = '.png';
        } else if (rawMimeType.includes('webp')) {
          mimeType = 'image/webp'; extension = '.webp';
        } else if (rawMimeType.includes('gif')) {
          mimeType = 'image/gif'; extension = '.gif';
        } else if (rawMimeType.includes('pdf')) {
          mimeType = 'application/pdf'; extension = '.pdf';
        } else if (rawMimeType.includes('msword')) {
          mimeType = 'application/msword'; extension = '.doc';
        } else if (rawMimeType.includes('wordprocessingml')) {
          mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; extension = '.docx';
        } else if (rawMimeType.includes('plain')) {
          mimeType = 'text/plain'; extension = '.txt';
        } else if (rawMimeType.includes('mp3')) {
          mimeType = 'audio/mpeg'; extension = '.mp3';
        } else if (rawMimeType.includes('wav')) {
          mimeType = 'audio/wav'; extension = '.wav';
        } else if (rawMimeType.includes('m4a') || rawMimeType.includes('mp4')) {
          mimeType = 'audio/mp4'; extension = '.m4a';
        } else if (rawMimeType.includes('ogg')) {
          mimeType = 'audio/ogg'; extension = '.ogg';
        } else if (rawMimeType.includes('webm')) {
          try {
            buffer = await convertToOgg(buffer, 'webm');
            mimeType = 'audio/ogg';
            extension = '.ogg';
            console.log('[Audio] Successfully converted WebM → OGG/Opus for WhatsApp delivery');
          } catch (convErr) {
            console.warn('[Audio] WebM→OGG conversion failed, uploading as-is:', convErr.message);
            mimeType = 'audio/ogg';
            extension = '.ogg';
          }
        } else {
          extension = '.bin';
        }
      } else {
        const extLower = extension.toLowerCase();
        if (extLower === '.pdf') mimeType = 'application/pdf';
        else if (extLower === '.jpg' || extLower === '.jpeg') mimeType = 'image/jpeg';
        else if (extLower === '.png') mimeType = 'image/png';
        else if (extLower === '.webp') mimeType = 'image/webp';
        else if (extLower === '.gif') mimeType = 'image/gif';
        else if (extLower === '.doc') mimeType = 'application/msword';
        else if (extLower === '.docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        else if (extLower === '.txt') mimeType = 'text/plain';

        if (rawMimeType.includes('webm')) {
          try {
            buffer = await convertToOgg(buffer, 'webm');
            mimeType = 'audio/ogg';
            extension = '.ogg';
          } catch {
            mimeType = 'audio/ogg';
            extension = '.ogg';
          }
        }
      }

      const result = await this.uploadBuffer(buffer, {
        folder,
        mimeType,
        extension,
        originalName: options.fileName
      });

      if (!result) {
        throw new Error('Azure Blob Storage upload did not return a valid result');
      }

      try {
        return this.generateSasUrl(result.public_id, 86400 * 30);
      } catch (sasError) {
        console.warn('[Azure Storage] SAS generation failed, returning direct URL:', sasError.message);
        return result.url;
      }
    } catch (error) {
      console.error('Failed to upload data URL to Azure Blob Storage:', error);
      throw error;
    }
  }

  async delete(publicId, options = {}) {
    if (!this.isConfigured) {
      throw new Error('Azure Blob storage provider is not configured.');
    }

    const blockBlobClient = this.containerClient.getBlockBlobClient(publicId);
    await blockBlobClient.deleteIfExists();
    return { result: 'ok' };
  }

  generateSasUrl(blobName, expiresAfterSeconds = 3600) {
    if (!this.isConfigured) {
      throw new Error('Azure Blob storage provider is not configured.');
    }
    if (!this.accountName || !this.accountKey) {
      throw new Error('Azure Storage Account credentials could not be parsed from connection string.');
    }

    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    const credential = new StorageSharedKeyCredential(this.accountName, this.accountKey);
    
    const sasToken = generateBlobSASQueryParameters({
      containerName: this.config.container,
      blobName: blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(new Date().valueOf() - 5 * 60 * 1000), // Subtract 5 minutes for clock skew
      expiresOn: new Date(new Date().valueOf() + expiresAfterSeconds * 1000)
    }, credential).toString();

    return `${blockBlobClient.url}?${sasToken}`;
  }
}

module.exports = AzureBlobProvider;
