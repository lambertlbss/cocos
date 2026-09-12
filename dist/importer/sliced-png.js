/*! Bundled pngjs 7.0.0
pngjs original work Copyright (c) 2015 Luke Page & Original Contributors
pngjs derived work Copyright (c) 2012 Kuba Niegowski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/pngjs/lib/chunkstream.js
var require_chunkstream = __commonJS({
  "node_modules/pngjs/lib/chunkstream.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var ChunkStream = module2.exports = function() {
      Stream.call(this);
      this._buffers = [];
      this._buffered = 0;
      this._reads = [];
      this._paused = false;
      this._encoding = "utf8";
      this.writable = true;
    };
    util.inherits(ChunkStream, Stream);
    ChunkStream.prototype.read = function(length, callback) {
      this._reads.push({
        length: Math.abs(length),
        // if length < 0 then at most this length
        allowLess: length < 0,
        func: callback
      });
      process.nextTick(
        function() {
          this._process();
          if (this._paused && this._reads && this._reads.length > 0) {
            this._paused = false;
            this.emit("drain");
          }
        }.bind(this)
      );
    };
    ChunkStream.prototype.write = function(data, encoding) {
      if (!this.writable) {
        this.emit("error", new Error("Stream not writable"));
        return false;
      }
      let dataBuffer;
      if (Buffer.isBuffer(data)) {
        dataBuffer = data;
      } else {
        dataBuffer = Buffer.from(data, encoding || this._encoding);
      }
      this._buffers.push(dataBuffer);
      this._buffered += dataBuffer.length;
      this._process();
      if (this._reads && this._reads.length === 0) {
        this._paused = true;
      }
      return this.writable && !this._paused;
    };
    ChunkStream.prototype.end = function(data, encoding) {
      if (data) {
        this.write(data, encoding);
      }
      this.writable = false;
      if (!this._buffers) {
        return;
      }
      if (this._buffers.length === 0) {
        this._end();
      } else {
        this._buffers.push(null);
        this._process();
      }
    };
    ChunkStream.prototype.destroySoon = ChunkStream.prototype.end;
    ChunkStream.prototype._end = function() {
      if (this._reads.length > 0) {
        this.emit("error", new Error("Unexpected end of input"));
      }
      this.destroy();
    };
    ChunkStream.prototype.destroy = function() {
      if (!this._buffers) {
        return;
      }
      this.writable = false;
      this._reads = null;
      this._buffers = null;
      this.emit("close");
    };
    ChunkStream.prototype._processReadAllowingLess = function(read) {
      this._reads.shift();
      let smallerBuf = this._buffers[0];
      if (smallerBuf.length > read.length) {
        this._buffered -= read.length;
        this._buffers[0] = smallerBuf.slice(read.length);
        read.func.call(this, smallerBuf.slice(0, read.length));
      } else {
        this._buffered -= smallerBuf.length;
        this._buffers.shift();
        read.func.call(this, smallerBuf);
      }
    };
    ChunkStream.prototype._processRead = function(read) {
      this._reads.shift();
      let pos = 0;
      let count = 0;
      let data = Buffer.alloc(read.length);
      while (pos < read.length) {
        let buf = this._buffers[count++];
        let len = Math.min(buf.length, read.length - pos);
        buf.copy(data, pos, 0, len);
        pos += len;
        if (len !== buf.length) {
          this._buffers[--count] = buf.slice(len);
        }
      }
      if (count > 0) {
        this._buffers.splice(0, count);
      }
      this._buffered -= read.length;
      read.func.call(this, data);
    };
    ChunkStream.prototype._process = function() {
      try {
        while (this._buffered > 0 && this._reads && this._reads.length > 0) {
          let read = this._reads[0];
          if (read.allowLess) {
            this._processReadAllowingLess(read);
          } else if (this._buffered >= read.length) {
            this._processRead(read);
          } else {
            break;
          }
        }
        if (this._buffers && !this.writable) {
          this._end();
        }
      } catch (ex) {
        this.emit("error", ex);
      }
    };
  }
});

// node_modules/pngjs/lib/interlace.js
var require_interlace = __commonJS({
  "node_modules/pngjs/lib/interlace.js"(exports2) {
    "use strict";
    var imagePasses = [
      {
        // pass 1 - 1px
        x: [0],
        y: [0]
      },
      {
        // pass 2 - 1px
        x: [4],
        y: [0]
      },
      {
        // pass 3 - 2px
        x: [0, 4],
        y: [4]
      },
      {
        // pass 4 - 4px
        x: [2, 6],
        y: [0, 4]
      },
      {
        // pass 5 - 8px
        x: [0, 2, 4, 6],
        y: [2, 6]
      },
      {
        // pass 6 - 16px
        x: [1, 3, 5, 7],
        y: [0, 2, 4, 6]
      },
      {
        // pass 7 - 32px
        x: [0, 1, 2, 3, 4, 5, 6, 7],
        y: [1, 3, 5, 7]
      }
    ];
    exports2.getImagePasses = function(width, height) {
      let images = [];
      let xLeftOver = width % 8;
      let yLeftOver = height % 8;
      let xRepeats = (width - xLeftOver) / 8;
      let yRepeats = (height - yLeftOver) / 8;
      for (let i = 0; i < imagePasses.length; i++) {
        let pass = imagePasses[i];
        let passWidth = xRepeats * pass.x.length;
        let passHeight = yRepeats * pass.y.length;
        for (let j = 0; j < pass.x.length; j++) {
          if (pass.x[j] < xLeftOver) {
            passWidth++;
          } else {
            break;
          }
        }
        for (let j = 0; j < pass.y.length; j++) {
          if (pass.y[j] < yLeftOver) {
            passHeight++;
          } else {
            break;
          }
        }
        if (passWidth > 0 && passHeight > 0) {
          images.push({ width: passWidth, height: passHeight, index: i });
        }
      }
      return images;
    };
    exports2.getInterlaceIterator = function(width) {
      return function(x, y, pass) {
        let outerXLeftOver = x % imagePasses[pass].x.length;
        let outerX = (x - outerXLeftOver) / imagePasses[pass].x.length * 8 + imagePasses[pass].x[outerXLeftOver];
        let outerYLeftOver = y % imagePasses[pass].y.length;
        let outerY = (y - outerYLeftOver) / imagePasses[pass].y.length * 8 + imagePasses[pass].y[outerYLeftOver];
        return outerX * 4 + outerY * width * 4;
      };
    };
  }
});

// node_modules/pngjs/lib/paeth-predictor.js
var require_paeth_predictor = __commonJS({
  "node_modules/pngjs/lib/paeth-predictor.js"(exports2, module2) {
    "use strict";
    module2.exports = function paethPredictor(left, above, upLeft) {
      let paeth = left + above - upLeft;
      let pLeft = Math.abs(paeth - left);
      let pAbove = Math.abs(paeth - above);
      let pUpLeft = Math.abs(paeth - upLeft);
      if (pLeft <= pAbove && pLeft <= pUpLeft) {
        return left;
      }
      if (pAbove <= pUpLeft) {
        return above;
      }
      return upLeft;
    };
  }
});

// node_modules/pngjs/lib/filter-parse.js
var require_filter_parse = __commonJS({
  "node_modules/pngjs/lib/filter-parse.js"(exports2, module2) {
    "use strict";
    var interlaceUtils = require_interlace();
    var paethPredictor = require_paeth_predictor();
    function getByteWidth(width, bpp, depth) {
      let byteWidth = width * bpp;
      if (depth !== 8) {
        byteWidth = Math.ceil(byteWidth / (8 / depth));
      }
      return byteWidth;
    }
    var Filter = module2.exports = function(bitmapInfo, dependencies) {
      let width = bitmapInfo.width;
      let height = bitmapInfo.height;
      let interlace = bitmapInfo.interlace;
      let bpp = bitmapInfo.bpp;
      let depth = bitmapInfo.depth;
      this.read = dependencies.read;
      this.write = dependencies.write;
      this.complete = dependencies.complete;
      this._imageIndex = 0;
      this._images = [];
      if (interlace) {
        let passes = interlaceUtils.getImagePasses(width, height);
        for (let i = 0; i < passes.length; i++) {
          this._images.push({
            byteWidth: getByteWidth(passes[i].width, bpp, depth),
            height: passes[i].height,
            lineIndex: 0
          });
        }
      } else {
        this._images.push({
          byteWidth: getByteWidth(width, bpp, depth),
          height,
          lineIndex: 0
        });
      }
      if (depth === 8) {
        this._xComparison = bpp;
      } else if (depth === 16) {
        this._xComparison = bpp * 2;
      } else {
        this._xComparison = 1;
      }
    };
    Filter.prototype.start = function() {
      this.read(
        this._images[this._imageIndex].byteWidth + 1,
        this._reverseFilterLine.bind(this)
      );
    };
    Filter.prototype._unFilterType1 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f1Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        unfilteredLine[x] = rawByte + f1Left;
      }
    };
    Filter.prototype._unFilterType2 = function(rawData, unfilteredLine, byteWidth) {
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f2Up = lastLine ? lastLine[x] : 0;
        unfilteredLine[x] = rawByte + f2Up;
      }
    };
    Filter.prototype._unFilterType3 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f3Up = lastLine ? lastLine[x] : 0;
        let f3Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        let f3Add = Math.floor((f3Left + f3Up) / 2);
        unfilteredLine[x] = rawByte + f3Add;
      }
    };
    Filter.prototype._unFilterType4 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f4Up = lastLine ? lastLine[x] : 0;
        let f4Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        let f4UpLeft = x > xBiggerThan && lastLine ? lastLine[x - xComparison] : 0;
        let f4Add = paethPredictor(f4Left, f4Up, f4UpLeft);
        unfilteredLine[x] = rawByte + f4Add;
      }
    };
    Filter.prototype._reverseFilterLine = function(rawData) {
      let filter = rawData[0];
      let unfilteredLine;
      let currentImage = this._images[this._imageIndex];
      let byteWidth = currentImage.byteWidth;
      if (filter === 0) {
        unfilteredLine = rawData.slice(1, byteWidth + 1);
      } else {
        unfilteredLine = Buffer.alloc(byteWidth);
        switch (filter) {
          case 1:
            this._unFilterType1(rawData, unfilteredLine, byteWidth);
            break;
          case 2:
            this._unFilterType2(rawData, unfilteredLine, byteWidth);
            break;
          case 3:
            this._unFilterType3(rawData, unfilteredLine, byteWidth);
            break;
          case 4:
            this._unFilterType4(rawData, unfilteredLine, byteWidth);
            break;
          default:
            throw new Error("Unrecognised filter type - " + filter);
        }
      }
      this.write(unfilteredLine);
      currentImage.lineIndex++;
      if (currentImage.lineIndex >= currentImage.height) {
        this._lastLine = null;
        this._imageIndex++;
        currentImage = this._images[this._imageIndex];
      } else {
        this._lastLine = unfilteredLine;
      }
      if (currentImage) {
        this.read(currentImage.byteWidth + 1, this._reverseFilterLine.bind(this));
      } else {
        this._lastLine = null;
        this.complete();
      }
    };
  }
});

// node_modules/pngjs/lib/filter-parse-async.js
var require_filter_parse_async = __commonJS({
  "node_modules/pngjs/lib/filter-parse-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var ChunkStream = require_chunkstream();
    var Filter = require_filter_parse();
    var FilterAsync = module2.exports = function(bitmapInfo) {
      ChunkStream.call(this);
      let buffers = [];
      let that = this;
      this._filter = new Filter(bitmapInfo, {
        read: this.read.bind(this),
        write: function(buffer) {
          buffers.push(buffer);
        },
        complete: function() {
          that.emit("complete", Buffer.concat(buffers));
        }
      });
      this._filter.start();
    };
    util.inherits(FilterAsync, ChunkStream);
  }
});

// node_modules/pngjs/lib/constants.js
var require_constants = __commonJS({
  "node_modules/pngjs/lib/constants.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      PNG_SIGNATURE: [137, 80, 78, 71, 13, 10, 26, 10],
      TYPE_IHDR: 1229472850,
      TYPE_IEND: 1229278788,
      TYPE_IDAT: 1229209940,
      TYPE_PLTE: 1347179589,
      TYPE_tRNS: 1951551059,
      // eslint-disable-line camelcase
      TYPE_gAMA: 1732332865,
      // eslint-disable-line camelcase
      // color-type bits
      COLORTYPE_GRAYSCALE: 0,
      COLORTYPE_PALETTE: 1,
      COLORTYPE_COLOR: 2,
      COLORTYPE_ALPHA: 4,
      // e.g. grayscale and alpha
      // color-type combinations
      COLORTYPE_PALETTE_COLOR: 3,
      COLORTYPE_COLOR_ALPHA: 6,
      COLORTYPE_TO_BPP_MAP: {
        0: 1,
        2: 3,
        3: 1,
        4: 2,
        6: 4
      },
      GAMMA_DIVISION: 1e5
    };
  }
});

// node_modules/pngjs/lib/crc.js
var require_crc = __commonJS({
  "node_modules/pngjs/lib/crc.js"(exports2, module2) {
    "use strict";
    var crcTable = [];
    (function() {
      for (let i = 0; i < 256; i++) {
        let currentCrc = i;
        for (let j = 0; j < 8; j++) {
          if (currentCrc & 1) {
            currentCrc = 3988292384 ^ currentCrc >>> 1;
          } else {
            currentCrc = currentCrc >>> 1;
          }
        }
        crcTable[i] = currentCrc;
      }
    })();
    var CrcCalculator = module2.exports = function() {
      this._crc = -1;
    };
    CrcCalculator.prototype.write = function(data) {
      for (let i = 0; i < data.length; i++) {
        this._crc = crcTable[(this._crc ^ data[i]) & 255] ^ this._crc >>> 8;
      }
      return true;
    };
    CrcCalculator.prototype.crc32 = function() {
      return this._crc ^ -1;
    };
    CrcCalculator.crc32 = function(buf) {
      let crc = -1;
      for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 255] ^ crc >>> 8;
      }
      return crc ^ -1;
    };
  }
});

// node_modules/pngjs/lib/parser.js
var require_parser = __commonJS({
  "node_modules/pngjs/lib/parser.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    var CrcCalculator = require_crc();
    var Parser = module2.exports = function(options, dependencies) {
      this._options = options;
      options.checkCRC = options.checkCRC !== false;
      this._hasIHDR = false;
      this._hasIEND = false;
      this._emittedHeadersFinished = false;
      this._palette = [];
      this._colorType = 0;
      this._chunks = {};
      this._chunks[constants.TYPE_IHDR] = this._handleIHDR.bind(this);
      this._chunks[constants.TYPE_IEND] = this._handleIEND.bind(this);
      this._chunks[constants.TYPE_IDAT] = this._handleIDAT.bind(this);
      this._chunks[constants.TYPE_PLTE] = this._handlePLTE.bind(this);
      this._chunks[constants.TYPE_tRNS] = this._handleTRNS.bind(this);
      this._chunks[constants.TYPE_gAMA] = this._handleGAMA.bind(this);
      this.read = dependencies.read;
      this.error = dependencies.error;
      this.metadata = dependencies.metadata;
      this.gamma = dependencies.gamma;
      this.transColor = dependencies.transColor;
      this.palette = dependencies.palette;
      this.parsed = dependencies.parsed;
      this.inflateData = dependencies.inflateData;
      this.finished = dependencies.finished;
      this.simpleTransparency = dependencies.simpleTransparency;
      this.headersFinished = dependencies.headersFinished || function() {
      };
    };
    Parser.prototype.start = function() {
      this.read(constants.PNG_SIGNATURE.length, this._parseSignature.bind(this));
    };
    Parser.prototype._parseSignature = function(data) {
      let signature = constants.PNG_SIGNATURE;
      for (let i = 0; i < signature.length; i++) {
        if (data[i] !== signature[i]) {
          this.error(new Error("Invalid file signature"));
          return;
        }
      }
      this.read(8, this._parseChunkBegin.bind(this));
    };
    Parser.prototype._parseChunkBegin = function(data) {
      let length = data.readUInt32BE(0);
      let type = data.readUInt32BE(4);
      let name = "";
      for (let i = 4; i < 8; i++) {
        name += String.fromCharCode(data[i]);
      }
      let ancillary = Boolean(data[4] & 32);
      if (!this._hasIHDR && type !== constants.TYPE_IHDR) {
        this.error(new Error("Expected IHDR on beggining"));
        return;
      }
      this._crc = new CrcCalculator();
      this._crc.write(Buffer.from(name));
      if (this._chunks[type]) {
        return this._chunks[type](length);
      }
      if (!ancillary) {
        this.error(new Error("Unsupported critical chunk type " + name));
        return;
      }
      this.read(length + 4, this._skipChunk.bind(this));
    };
    Parser.prototype._skipChunk = function() {
      this.read(8, this._parseChunkBegin.bind(this));
    };
    Parser.prototype._handleChunkEnd = function() {
      this.read(4, this._parseChunkEnd.bind(this));
    };
    Parser.prototype._parseChunkEnd = function(data) {
      let fileCrc = data.readInt32BE(0);
      let calcCrc = this._crc.crc32();
      if (this._options.checkCRC && calcCrc !== fileCrc) {
        this.error(new Error("Crc error - " + fileCrc + " - " + calcCrc));
        return;
      }
      if (!this._hasIEND) {
        this.read(8, this._parseChunkBegin.bind(this));
      }
    };
    Parser.prototype._handleIHDR = function(length) {
      this.read(length, this._parseIHDR.bind(this));
    };
    Parser.prototype._parseIHDR = function(data) {
      this._crc.write(data);
      let width = data.readUInt32BE(0);
      let height = data.readUInt32BE(4);
      let depth = data[8];
      let colorType = data[9];
      let compr = data[10];
      let filter = data[11];
      let interlace = data[12];
      if (depth !== 8 && depth !== 4 && depth !== 2 && depth !== 1 && depth !== 16) {
        this.error(new Error("Unsupported bit depth " + depth));
        return;
      }
      if (!(colorType in constants.COLORTYPE_TO_BPP_MAP)) {
        this.error(new Error("Unsupported color type"));
        return;
      }
      if (compr !== 0) {
        this.error(new Error("Unsupported compression method"));
        return;
      }
      if (filter !== 0) {
        this.error(new Error("Unsupported filter method"));
        return;
      }
      if (interlace !== 0 && interlace !== 1) {
        this.error(new Error("Unsupported interlace method"));
        return;
      }
      this._colorType = colorType;
      let bpp = constants.COLORTYPE_TO_BPP_MAP[this._colorType];
      this._hasIHDR = true;
      this.metadata({
        width,
        height,
        depth,
        interlace: Boolean(interlace),
        palette: Boolean(colorType & constants.COLORTYPE_PALETTE),
        color: Boolean(colorType & constants.COLORTYPE_COLOR),
        alpha: Boolean(colorType & constants.COLORTYPE_ALPHA),
        bpp,
        colorType
      });
      this._handleChunkEnd();
    };
    Parser.prototype._handlePLTE = function(length) {
      this.read(length, this._parsePLTE.bind(this));
    };
    Parser.prototype._parsePLTE = function(data) {
      this._crc.write(data);
      let entries = Math.floor(data.length / 3);
      for (let i = 0; i < entries; i++) {
        this._palette.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 255]);
      }
      this.palette(this._palette);
      this._handleChunkEnd();
    };
    Parser.prototype._handleTRNS = function(length) {
      this.simpleTransparency();
      this.read(length, this._parseTRNS.bind(this));
    };
    Parser.prototype._parseTRNS = function(data) {
      this._crc.write(data);
      if (this._colorType === constants.COLORTYPE_PALETTE_COLOR) {
        if (this._palette.length === 0) {
          this.error(new Error("Transparency chunk must be after palette"));
          return;
        }
        if (data.length > this._palette.length) {
          this.error(new Error("More transparent colors than palette size"));
          return;
        }
        for (let i = 0; i < data.length; i++) {
          this._palette[i][3] = data[i];
        }
        this.palette(this._palette);
      }
      if (this._colorType === constants.COLORTYPE_GRAYSCALE) {
        this.transColor([data.readUInt16BE(0)]);
      }
      if (this._colorType === constants.COLORTYPE_COLOR) {
        this.transColor([
          data.readUInt16BE(0),
          data.readUInt16BE(2),
          data.readUInt16BE(4)
        ]);
      }
      this._handleChunkEnd();
    };
    Parser.prototype._handleGAMA = function(length) {
      this.read(length, this._parseGAMA.bind(this));
    };
    Parser.prototype._parseGAMA = function(data) {
      this._crc.write(data);
      this.gamma(data.readUInt32BE(0) / constants.GAMMA_DIVISION);
      this._handleChunkEnd();
    };
    Parser.prototype._handleIDAT = function(length) {
      if (!this._emittedHeadersFinished) {
        this._emittedHeadersFinished = true;
        this.headersFinished();
      }
      this.read(-length, this._parseIDAT.bind(this, length));
    };
    Parser.prototype._parseIDAT = function(length, data) {
      this._crc.write(data);
      if (this._colorType === constants.COLORTYPE_PALETTE_COLOR && this._palette.length === 0) {
        throw new Error("Expected palette not found");
      }
      this.inflateData(data);
      let leftOverLength = length - data.length;
      if (leftOverLength > 0) {
        this._handleIDAT(leftOverLength);
      } else {
        this._handleChunkEnd();
      }
    };
    Parser.prototype._handleIEND = function(length) {
      this.read(length, this._parseIEND.bind(this));
    };
    Parser.prototype._parseIEND = function(data) {
      this._crc.write(data);
      this._hasIEND = true;
      this._handleChunkEnd();
      if (this.finished) {
        this.finished();
      }
    };
  }
});

// node_modules/pngjs/lib/bitmapper.js
var require_bitmapper = __commonJS({
  "node_modules/pngjs/lib/bitmapper.js"(exports2) {
    "use strict";
    var interlaceUtils = require_interlace();
    var pixelBppMapper = [
      // 0 - dummy entry
      function() {
      },
      // 1 - L
      // 0: 0, 1: 0, 2: 0, 3: 0xff
      function(pxData, data, pxPos, rawPos) {
        if (rawPos === data.length) {
          throw new Error("Ran out of data");
        }
        let pixel = data[rawPos];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = 255;
      },
      // 2 - LA
      // 0: 0, 1: 0, 2: 0, 3: 1
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 1 >= data.length) {
          throw new Error("Ran out of data");
        }
        let pixel = data[rawPos];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = data[rawPos + 1];
      },
      // 3 - RGB
      // 0: 0, 1: 1, 2: 2, 3: 0xff
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 2 >= data.length) {
          throw new Error("Ran out of data");
        }
        pxData[pxPos] = data[rawPos];
        pxData[pxPos + 1] = data[rawPos + 1];
        pxData[pxPos + 2] = data[rawPos + 2];
        pxData[pxPos + 3] = 255;
      },
      // 4 - RGBA
      // 0: 0, 1: 1, 2: 2, 3: 3
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 3 >= data.length) {
          throw new Error("Ran out of data");
        }
        pxData[pxPos] = data[rawPos];
        pxData[pxPos + 1] = data[rawPos + 1];
        pxData[pxPos + 2] = data[rawPos + 2];
        pxData[pxPos + 3] = data[rawPos + 3];
      }
    ];
    var pixelBppCustomMapper = [
      // 0 - dummy entry
      function() {
      },
      // 1 - L
      // 0: 0, 1: 0, 2: 0, 3: 0xff
      function(pxData, pixelData, pxPos, maxBit) {
        let pixel = pixelData[0];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = maxBit;
      },
      // 2 - LA
      // 0: 0, 1: 0, 2: 0, 3: 1
      function(pxData, pixelData, pxPos) {
        let pixel = pixelData[0];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = pixelData[1];
      },
      // 3 - RGB
      // 0: 0, 1: 1, 2: 2, 3: 0xff
      function(pxData, pixelData, pxPos, maxBit) {
        pxData[pxPos] = pixelData[0];
        pxData[pxPos + 1] = pixelData[1];
        pxData[pxPos + 2] = pixelData[2];
        pxData[pxPos + 3] = maxBit;
      },
      // 4 - RGBA
      // 0: 0, 1: 1, 2: 2, 3: 3
      function(pxData, pixelData, pxPos) {
        pxData[pxPos] = pixelData[0];
        pxData[pxPos + 1] = pixelData[1];
        pxData[pxPos + 2] = pixelData[2];
        pxData[pxPos + 3] = pixelData[3];
      }
    ];
    function bitRetriever(data, depth) {
      let leftOver = [];
      let i = 0;
      function split() {
        if (i === data.length) {
          throw new Error("Ran out of data");
        }
        let byte = data[i];
        i++;
        let byte8, byte7, byte6, byte5, byte4, byte3, byte2, byte1;
        switch (depth) {
          default:
            throw new Error("unrecognised depth");
          case 16:
            byte2 = data[i];
            i++;
            leftOver.push((byte << 8) + byte2);
            break;
          case 4:
            byte2 = byte & 15;
            byte1 = byte >> 4;
            leftOver.push(byte1, byte2);
            break;
          case 2:
            byte4 = byte & 3;
            byte3 = byte >> 2 & 3;
            byte2 = byte >> 4 & 3;
            byte1 = byte >> 6 & 3;
            leftOver.push(byte1, byte2, byte3, byte4);
            break;
          case 1:
            byte8 = byte & 1;
            byte7 = byte >> 1 & 1;
            byte6 = byte >> 2 & 1;
            byte5 = byte >> 3 & 1;
            byte4 = byte >> 4 & 1;
            byte3 = byte >> 5 & 1;
            byte2 = byte >> 6 & 1;
            byte1 = byte >> 7 & 1;
            leftOver.push(byte1, byte2, byte3, byte4, byte5, byte6, byte7, byte8);
            break;
        }
      }
      return {
        get: function(count) {
          while (leftOver.length < count) {
            split();
          }
          let returner = leftOver.slice(0, count);
          leftOver = leftOver.slice(count);
          return returner;
        },
        resetAfterLine: function() {
          leftOver.length = 0;
        },
        end: function() {
          if (i !== data.length) {
            throw new Error("extra data found");
          }
        }
      };
    }
    function mapImage8Bit(image, pxData, getPxPos, bpp, data, rawPos) {
      let imageWidth = image.width;
      let imageHeight = image.height;
      let imagePass = image.index;
      for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
          let pxPos = getPxPos(x, y, imagePass);
          pixelBppMapper[bpp](pxData, data, pxPos, rawPos);
          rawPos += bpp;
        }
      }
      return rawPos;
    }
    function mapImageCustomBit(image, pxData, getPxPos, bpp, bits, maxBit) {
      let imageWidth = image.width;
      let imageHeight = image.height;
      let imagePass = image.index;
      for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
          let pixelData = bits.get(bpp);
          let pxPos = getPxPos(x, y, imagePass);
          pixelBppCustomMapper[bpp](pxData, pixelData, pxPos, maxBit);
        }
        bits.resetAfterLine();
      }
    }
    exports2.dataToBitMap = function(data, bitmapInfo) {
      let width = bitmapInfo.width;
      let height = bitmapInfo.height;
      let depth = bitmapInfo.depth;
      let bpp = bitmapInfo.bpp;
      let interlace = bitmapInfo.interlace;
      let bits;
      if (depth !== 8) {
        bits = bitRetriever(data, depth);
      }
      let pxData;
      if (depth <= 8) {
        pxData = Buffer.alloc(width * height * 4);
      } else {
        pxData = new Uint16Array(width * height * 4);
      }
      let maxBit = Math.pow(2, depth) - 1;
      let rawPos = 0;
      let images;
      let getPxPos;
      if (interlace) {
        images = interlaceUtils.getImagePasses(width, height);
        getPxPos = interlaceUtils.getInterlaceIterator(width, height);
      } else {
        let nonInterlacedPxPos = 0;
        getPxPos = function() {
          let returner = nonInterlacedPxPos;
          nonInterlacedPxPos += 4;
          return returner;
        };
        images = [{ width, height }];
      }
      for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
        if (depth === 8) {
          rawPos = mapImage8Bit(
            images[imageIndex],
            pxData,
            getPxPos,
            bpp,
            data,
            rawPos
          );
        } else {
          mapImageCustomBit(
            images[imageIndex],
            pxData,
            getPxPos,
            bpp,
            bits,
            maxBit
          );
        }
      }
      if (depth === 8) {
        if (rawPos !== data.length) {
          throw new Error("extra data found");
        }
      } else {
        bits.end();
      }
      return pxData;
    };
  }
});

// node_modules/pngjs/lib/format-normaliser.js
var require_format_normaliser = __commonJS({
  "node_modules/pngjs/lib/format-normaliser.js"(exports2, module2) {
    "use strict";
    function dePalette(indata, outdata, width, height, palette) {
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let color = palette[indata[pxPos]];
          if (!color) {
            throw new Error("index " + indata[pxPos] + " not in palette");
          }
          for (let i = 0; i < 4; i++) {
            outdata[pxPos + i] = color[i];
          }
          pxPos += 4;
        }
      }
    }
    function replaceTransparentColor(indata, outdata, width, height, transColor) {
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let makeTrans = false;
          if (transColor.length === 1) {
            if (transColor[0] === indata[pxPos]) {
              makeTrans = true;
            }
          } else if (transColor[0] === indata[pxPos] && transColor[1] === indata[pxPos + 1] && transColor[2] === indata[pxPos + 2]) {
            makeTrans = true;
          }
          if (makeTrans) {
            for (let i = 0; i < 4; i++) {
              outdata[pxPos + i] = 0;
            }
          }
          pxPos += 4;
        }
      }
    }
    function scaleDepth(indata, outdata, width, height, depth) {
      let maxOutSample = 255;
      let maxInSample = Math.pow(2, depth) - 1;
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          for (let i = 0; i < 4; i++) {
            outdata[pxPos + i] = Math.floor(
              indata[pxPos + i] * maxOutSample / maxInSample + 0.5
            );
          }
          pxPos += 4;
        }
      }
    }
    module2.exports = function(indata, imageData, skipRescale = false) {
      let depth = imageData.depth;
      let width = imageData.width;
      let height = imageData.height;
      let colorType = imageData.colorType;
      let transColor = imageData.transColor;
      let palette = imageData.palette;
      let outdata = indata;
      if (colorType === 3) {
        dePalette(indata, outdata, width, height, palette);
      } else {
        if (transColor) {
          replaceTransparentColor(indata, outdata, width, height, transColor);
        }
        if (depth !== 8 && !skipRescale) {
          if (depth === 16) {
            outdata = Buffer.alloc(width * height * 4);
          }
          scaleDepth(indata, outdata, width, height, depth);
        }
      }
      return outdata;
    };
  }
});

// node_modules/pngjs/lib/parser-async.js
var require_parser_async = __commonJS({
  "node_modules/pngjs/lib/parser-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var zlib = require("zlib");
    var ChunkStream = require_chunkstream();
    var FilterAsync = require_filter_parse_async();
    var Parser = require_parser();
    var bitmapper = require_bitmapper();
    var formatNormaliser = require_format_normaliser();
    var ParserAsync = module2.exports = function(options) {
      ChunkStream.call(this);
      this._parser = new Parser(options, {
        read: this.read.bind(this),
        error: this._handleError.bind(this),
        metadata: this._handleMetaData.bind(this),
        gamma: this.emit.bind(this, "gamma"),
        palette: this._handlePalette.bind(this),
        transColor: this._handleTransColor.bind(this),
        finished: this._finished.bind(this),
        inflateData: this._inflateData.bind(this),
        simpleTransparency: this._simpleTransparency.bind(this),
        headersFinished: this._headersFinished.bind(this)
      });
      this._options = options;
      this.writable = true;
      this._parser.start();
    };
    util.inherits(ParserAsync, ChunkStream);
    ParserAsync.prototype._handleError = function(err) {
      this.emit("error", err);
      this.writable = false;
      this.destroy();
      if (this._inflate && this._inflate.destroy) {
        this._inflate.destroy();
      }
      if (this._filter) {
        this._filter.destroy();
        this._filter.on("error", function() {
        });
      }
      this.errord = true;
    };
    ParserAsync.prototype._inflateData = function(data) {
      if (!this._inflate) {
        if (this._bitmapInfo.interlace) {
          this._inflate = zlib.createInflate();
          this._inflate.on("error", this.emit.bind(this, "error"));
          this._filter.on("complete", this._complete.bind(this));
          this._inflate.pipe(this._filter);
        } else {
          let rowSize = (this._bitmapInfo.width * this._bitmapInfo.bpp * this._bitmapInfo.depth + 7 >> 3) + 1;
          let imageSize = rowSize * this._bitmapInfo.height;
          let chunkSize = Math.max(imageSize, zlib.Z_MIN_CHUNK);
          this._inflate = zlib.createInflate({ chunkSize });
          let leftToInflate = imageSize;
          let emitError = this.emit.bind(this, "error");
          this._inflate.on("error", function(err) {
            if (!leftToInflate) {
              return;
            }
            emitError(err);
          });
          this._filter.on("complete", this._complete.bind(this));
          let filterWrite = this._filter.write.bind(this._filter);
          this._inflate.on("data", function(chunk) {
            if (!leftToInflate) {
              return;
            }
            if (chunk.length > leftToInflate) {
              chunk = chunk.slice(0, leftToInflate);
            }
            leftToInflate -= chunk.length;
            filterWrite(chunk);
          });
          this._inflate.on("end", this._filter.end.bind(this._filter));
        }
      }
      this._inflate.write(data);
    };
    ParserAsync.prototype._handleMetaData = function(metaData) {
      this._metaData = metaData;
      this._bitmapInfo = Object.create(metaData);
      this._filter = new FilterAsync(this._bitmapInfo);
    };
    ParserAsync.prototype._handleTransColor = function(transColor) {
      this._bitmapInfo.transColor = transColor;
    };
    ParserAsync.prototype._handlePalette = function(palette) {
      this._bitmapInfo.palette = palette;
    };
    ParserAsync.prototype._simpleTransparency = function() {
      this._metaData.alpha = true;
    };
    ParserAsync.prototype._headersFinished = function() {
      this.emit("metadata", this._metaData);
    };
    ParserAsync.prototype._finished = function() {
      if (this.errord) {
        return;
      }
      if (!this._inflate) {
        this.emit("error", "No Inflate block");
      } else {
        this._inflate.end();
      }
    };
    ParserAsync.prototype._complete = function(filteredData) {
      if (this.errord) {
        return;
      }
      let normalisedBitmapData;
      try {
        let bitmapData = bitmapper.dataToBitMap(filteredData, this._bitmapInfo);
        normalisedBitmapData = formatNormaliser(
          bitmapData,
          this._bitmapInfo,
          this._options.skipRescale
        );
        bitmapData = null;
      } catch (ex) {
        this._handleError(ex);
        return;
      }
      this.emit("parsed", normalisedBitmapData);
    };
  }
});

// node_modules/pngjs/lib/bitpacker.js
var require_bitpacker = __commonJS({
  "node_modules/pngjs/lib/bitpacker.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    module2.exports = function(dataIn, width, height, options) {
      let outHasAlpha = [constants.COLORTYPE_COLOR_ALPHA, constants.COLORTYPE_ALPHA].indexOf(
        options.colorType
      ) !== -1;
      if (options.colorType === options.inputColorType) {
        let bigEndian = (function() {
          let buffer = new ArrayBuffer(2);
          new DataView(buffer).setInt16(
            0,
            256,
            true
            /* littleEndian */
          );
          return new Int16Array(buffer)[0] !== 256;
        })();
        if (options.bitDepth === 8 || options.bitDepth === 16 && bigEndian) {
          return dataIn;
        }
      }
      let data = options.bitDepth !== 16 ? dataIn : new Uint16Array(dataIn.buffer);
      let maxValue = 255;
      let inBpp = constants.COLORTYPE_TO_BPP_MAP[options.inputColorType];
      if (inBpp === 4 && !options.inputHasAlpha) {
        inBpp = 3;
      }
      let outBpp = constants.COLORTYPE_TO_BPP_MAP[options.colorType];
      if (options.bitDepth === 16) {
        maxValue = 65535;
        outBpp *= 2;
      }
      let outData = Buffer.alloc(width * height * outBpp);
      let inIndex = 0;
      let outIndex = 0;
      let bgColor = options.bgColor || {};
      if (bgColor.red === void 0) {
        bgColor.red = maxValue;
      }
      if (bgColor.green === void 0) {
        bgColor.green = maxValue;
      }
      if (bgColor.blue === void 0) {
        bgColor.blue = maxValue;
      }
      function getRGBA() {
        let red;
        let green;
        let blue;
        let alpha = maxValue;
        switch (options.inputColorType) {
          case constants.COLORTYPE_COLOR_ALPHA:
            alpha = data[inIndex + 3];
            red = data[inIndex];
            green = data[inIndex + 1];
            blue = data[inIndex + 2];
            break;
          case constants.COLORTYPE_COLOR:
            red = data[inIndex];
            green = data[inIndex + 1];
            blue = data[inIndex + 2];
            break;
          case constants.COLORTYPE_ALPHA:
            alpha = data[inIndex + 1];
            red = data[inIndex];
            green = red;
            blue = red;
            break;
          case constants.COLORTYPE_GRAYSCALE:
            red = data[inIndex];
            green = red;
            blue = red;
            break;
          default:
            throw new Error(
              "input color type:" + options.inputColorType + " is not supported at present"
            );
        }
        if (options.inputHasAlpha) {
          if (!outHasAlpha) {
            alpha /= maxValue;
            red = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.red + alpha * red), 0),
              maxValue
            );
            green = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.green + alpha * green), 0),
              maxValue
            );
            blue = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.blue + alpha * blue), 0),
              maxValue
            );
          }
        }
        return { red, green, blue, alpha };
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let rgba = getRGBA(data, inIndex);
          switch (options.colorType) {
            case constants.COLORTYPE_COLOR_ALPHA:
            case constants.COLORTYPE_COLOR:
              if (options.bitDepth === 8) {
                outData[outIndex] = rgba.red;
                outData[outIndex + 1] = rgba.green;
                outData[outIndex + 2] = rgba.blue;
                if (outHasAlpha) {
                  outData[outIndex + 3] = rgba.alpha;
                }
              } else {
                outData.writeUInt16BE(rgba.red, outIndex);
                outData.writeUInt16BE(rgba.green, outIndex + 2);
                outData.writeUInt16BE(rgba.blue, outIndex + 4);
                if (outHasAlpha) {
                  outData.writeUInt16BE(rgba.alpha, outIndex + 6);
                }
              }
              break;
            case constants.COLORTYPE_ALPHA:
            case constants.COLORTYPE_GRAYSCALE: {
              let grayscale = (rgba.red + rgba.green + rgba.blue) / 3;
              if (options.bitDepth === 8) {
                outData[outIndex] = grayscale;
                if (outHasAlpha) {
                  outData[outIndex + 1] = rgba.alpha;
                }
              } else {
                outData.writeUInt16BE(grayscale, outIndex);
                if (outHasAlpha) {
                  outData.writeUInt16BE(rgba.alpha, outIndex + 2);
                }
              }
              break;
            }
            default:
              throw new Error("unrecognised color Type " + options.colorType);
          }
          inIndex += inBpp;
          outIndex += outBpp;
        }
      }
      return outData;
    };
  }
});

// node_modules/pngjs/lib/filter-pack.js
var require_filter_pack = __commonJS({
  "node_modules/pngjs/lib/filter-pack.js"(exports2, module2) {
    "use strict";
    var paethPredictor = require_paeth_predictor();
    function filterNone(pxData, pxPos, byteWidth, rawData, rawPos) {
      for (let x = 0; x < byteWidth; x++) {
        rawData[rawPos + x] = pxData[pxPos + x];
      }
    }
    function filterSumNone(pxData, pxPos, byteWidth) {
      let sum = 0;
      let length = pxPos + byteWidth;
      for (let i = pxPos; i < length; i++) {
        sum += Math.abs(pxData[i]);
      }
      return sum;
    }
    function filterSub(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let val = pxData[pxPos + x] - left;
        rawData[rawPos + x] = val;
      }
    }
    function filterSumSub(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let val = pxData[pxPos + x] - left;
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterUp(pxData, pxPos, byteWidth, rawData, rawPos) {
      for (let x = 0; x < byteWidth; x++) {
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - up;
        rawData[rawPos + x] = val;
      }
    }
    function filterSumUp(pxData, pxPos, byteWidth) {
      let sum = 0;
      let length = pxPos + byteWidth;
      for (let x = pxPos; x < length; x++) {
        let up = pxPos > 0 ? pxData[x - byteWidth] : 0;
        let val = pxData[x] - up;
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterAvg(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - (left + up >> 1);
        rawData[rawPos + x] = val;
      }
    }
    function filterSumAvg(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - (left + up >> 1);
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterPaeth(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
        let val = pxData[pxPos + x] - paethPredictor(left, up, upleft);
        rawData[rawPos + x] = val;
      }
    }
    function filterSumPaeth(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
        let val = pxData[pxPos + x] - paethPredictor(left, up, upleft);
        sum += Math.abs(val);
      }
      return sum;
    }
    var filters = {
      0: filterNone,
      1: filterSub,
      2: filterUp,
      3: filterAvg,
      4: filterPaeth
    };
    var filterSums = {
      0: filterSumNone,
      1: filterSumSub,
      2: filterSumUp,
      3: filterSumAvg,
      4: filterSumPaeth
    };
    module2.exports = function(pxData, width, height, options, bpp) {
      let filterTypes;
      if (!("filterType" in options) || options.filterType === -1) {
        filterTypes = [0, 1, 2, 3, 4];
      } else if (typeof options.filterType === "number") {
        filterTypes = [options.filterType];
      } else {
        throw new Error("unrecognised filter types");
      }
      if (options.bitDepth === 16) {
        bpp *= 2;
      }
      let byteWidth = width * bpp;
      let rawPos = 0;
      let pxPos = 0;
      let rawData = Buffer.alloc((byteWidth + 1) * height);
      let sel = filterTypes[0];
      for (let y = 0; y < height; y++) {
        if (filterTypes.length > 1) {
          let min = Infinity;
          for (let i = 0; i < filterTypes.length; i++) {
            let sum = filterSums[filterTypes[i]](pxData, pxPos, byteWidth, bpp);
            if (sum < min) {
              sel = filterTypes[i];
              min = sum;
            }
          }
        }
        rawData[rawPos] = sel;
        rawPos++;
        filters[sel](pxData, pxPos, byteWidth, rawData, rawPos, bpp);
        rawPos += byteWidth;
        pxPos += byteWidth;
      }
      return rawData;
    };
  }
});

// node_modules/pngjs/lib/packer.js
var require_packer = __commonJS({
  "node_modules/pngjs/lib/packer.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    var CrcStream = require_crc();
    var bitPacker = require_bitpacker();
    var filter = require_filter_pack();
    var zlib = require("zlib");
    var Packer = module2.exports = function(options) {
      this._options = options;
      options.deflateChunkSize = options.deflateChunkSize || 32 * 1024;
      options.deflateLevel = options.deflateLevel != null ? options.deflateLevel : 9;
      options.deflateStrategy = options.deflateStrategy != null ? options.deflateStrategy : 3;
      options.inputHasAlpha = options.inputHasAlpha != null ? options.inputHasAlpha : true;
      options.deflateFactory = options.deflateFactory || zlib.createDeflate;
      options.bitDepth = options.bitDepth || 8;
      options.colorType = typeof options.colorType === "number" ? options.colorType : constants.COLORTYPE_COLOR_ALPHA;
      options.inputColorType = typeof options.inputColorType === "number" ? options.inputColorType : constants.COLORTYPE_COLOR_ALPHA;
      if ([
        constants.COLORTYPE_GRAYSCALE,
        constants.COLORTYPE_COLOR,
        constants.COLORTYPE_COLOR_ALPHA,
        constants.COLORTYPE_ALPHA
      ].indexOf(options.colorType) === -1) {
        throw new Error(
          "option color type:" + options.colorType + " is not supported at present"
        );
      }
      if ([
        constants.COLORTYPE_GRAYSCALE,
        constants.COLORTYPE_COLOR,
        constants.COLORTYPE_COLOR_ALPHA,
        constants.COLORTYPE_ALPHA
      ].indexOf(options.inputColorType) === -1) {
        throw new Error(
          "option input color type:" + options.inputColorType + " is not supported at present"
        );
      }
      if (options.bitDepth !== 8 && options.bitDepth !== 16) {
        throw new Error(
          "option bit depth:" + options.bitDepth + " is not supported at present"
        );
      }
    };
    Packer.prototype.getDeflateOptions = function() {
      return {
        chunkSize: this._options.deflateChunkSize,
        level: this._options.deflateLevel,
        strategy: this._options.deflateStrategy
      };
    };
    Packer.prototype.createDeflate = function() {
      return this._options.deflateFactory(this.getDeflateOptions());
    };
    Packer.prototype.filterData = function(data, width, height) {
      let packedData = bitPacker(data, width, height, this._options);
      let bpp = constants.COLORTYPE_TO_BPP_MAP[this._options.colorType];
      let filteredData = filter(packedData, width, height, this._options, bpp);
      return filteredData;
    };
    Packer.prototype._packChunk = function(type, data) {
      let len = data ? data.length : 0;
      let buf = Buffer.alloc(len + 12);
      buf.writeUInt32BE(len, 0);
      buf.writeUInt32BE(type, 4);
      if (data) {
        data.copy(buf, 8);
      }
      buf.writeInt32BE(
        CrcStream.crc32(buf.slice(4, buf.length - 4)),
        buf.length - 4
      );
      return buf;
    };
    Packer.prototype.packGAMA = function(gamma) {
      let buf = Buffer.alloc(4);
      buf.writeUInt32BE(Math.floor(gamma * constants.GAMMA_DIVISION), 0);
      return this._packChunk(constants.TYPE_gAMA, buf);
    };
    Packer.prototype.packIHDR = function(width, height) {
      let buf = Buffer.alloc(13);
      buf.writeUInt32BE(width, 0);
      buf.writeUInt32BE(height, 4);
      buf[8] = this._options.bitDepth;
      buf[9] = this._options.colorType;
      buf[10] = 0;
      buf[11] = 0;
      buf[12] = 0;
      return this._packChunk(constants.TYPE_IHDR, buf);
    };
    Packer.prototype.packIDAT = function(data) {
      return this._packChunk(constants.TYPE_IDAT, data);
    };
    Packer.prototype.packIEND = function() {
      return this._packChunk(constants.TYPE_IEND, null);
    };
  }
});

// node_modules/pngjs/lib/packer-async.js
var require_packer_async = __commonJS({
  "node_modules/pngjs/lib/packer-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var constants = require_constants();
    var Packer = require_packer();
    var PackerAsync = module2.exports = function(opt) {
      Stream.call(this);
      let options = opt || {};
      this._packer = new Packer(options);
      this._deflate = this._packer.createDeflate();
      this.readable = true;
    };
    util.inherits(PackerAsync, Stream);
    PackerAsync.prototype.pack = function(data, width, height, gamma) {
      this.emit("data", Buffer.from(constants.PNG_SIGNATURE));
      this.emit("data", this._packer.packIHDR(width, height));
      if (gamma) {
        this.emit("data", this._packer.packGAMA(gamma));
      }
      let filteredData = this._packer.filterData(data, width, height);
      this._deflate.on("error", this.emit.bind(this, "error"));
      this._deflate.on(
        "data",
        function(compressedData) {
          this.emit("data", this._packer.packIDAT(compressedData));
        }.bind(this)
      );
      this._deflate.on(
        "end",
        function() {
          this.emit("data", this._packer.packIEND());
          this.emit("end");
        }.bind(this)
      );
      this._deflate.end(filteredData);
    };
  }
});

// node_modules/pngjs/lib/sync-inflate.js
var require_sync_inflate = __commonJS({
  "node_modules/pngjs/lib/sync-inflate.js"(exports2, module2) {
    "use strict";
    var assert = require("assert").ok;
    var zlib = require("zlib");
    var util = require("util");
    var kMaxLength = require("buffer").kMaxLength;
    function Inflate(opts) {
      if (!(this instanceof Inflate)) {
        return new Inflate(opts);
      }
      if (opts && opts.chunkSize < zlib.Z_MIN_CHUNK) {
        opts.chunkSize = zlib.Z_MIN_CHUNK;
      }
      zlib.Inflate.call(this, opts);
      this._offset = this._offset === void 0 ? this._outOffset : this._offset;
      this._buffer = this._buffer || this._outBuffer;
      if (opts && opts.maxLength != null) {
        this._maxLength = opts.maxLength;
      }
    }
    function createInflate(opts) {
      return new Inflate(opts);
    }
    function _close(engine, callback) {
      if (callback) {
        process.nextTick(callback);
      }
      if (!engine._handle) {
        return;
      }
      engine._handle.close();
      engine._handle = null;
    }
    Inflate.prototype._processChunk = function(chunk, flushFlag, asyncCb) {
      if (typeof asyncCb === "function") {
        return zlib.Inflate._processChunk.call(this, chunk, flushFlag, asyncCb);
      }
      let self = this;
      let availInBefore = chunk && chunk.length;
      let availOutBefore = this._chunkSize - this._offset;
      let leftToInflate = this._maxLength;
      let inOff = 0;
      let buffers = [];
      let nread = 0;
      let error;
      this.on("error", function(err) {
        error = err;
      });
      function handleChunk(availInAfter, availOutAfter) {
        if (self._hadError) {
          return;
        }
        let have = availOutBefore - availOutAfter;
        assert(have >= 0, "have should not go down");
        if (have > 0) {
          let out = self._buffer.slice(self._offset, self._offset + have);
          self._offset += have;
          if (out.length > leftToInflate) {
            out = out.slice(0, leftToInflate);
          }
          buffers.push(out);
          nread += out.length;
          leftToInflate -= out.length;
          if (leftToInflate === 0) {
            return false;
          }
        }
        if (availOutAfter === 0 || self._offset >= self._chunkSize) {
          availOutBefore = self._chunkSize;
          self._offset = 0;
          self._buffer = Buffer.allocUnsafe(self._chunkSize);
        }
        if (availOutAfter === 0) {
          inOff += availInBefore - availInAfter;
          availInBefore = availInAfter;
          return true;
        }
        return false;
      }
      assert(this._handle, "zlib binding closed");
      let res;
      do {
        res = this._handle.writeSync(
          flushFlag,
          chunk,
          // in
          inOff,
          // in_off
          availInBefore,
          // in_len
          this._buffer,
          // out
          this._offset,
          //out_off
          availOutBefore
        );
        res = res || this._writeState;
      } while (!this._hadError && handleChunk(res[0], res[1]));
      if (this._hadError) {
        throw error;
      }
      if (nread >= kMaxLength) {
        _close(this);
        throw new RangeError(
          "Cannot create final Buffer. It would be larger than 0x" + kMaxLength.toString(16) + " bytes"
        );
      }
      let buf = Buffer.concat(buffers, nread);
      _close(this);
      return buf;
    };
    util.inherits(Inflate, zlib.Inflate);
    function zlibBufferSync(engine, buffer) {
      if (typeof buffer === "string") {
        buffer = Buffer.from(buffer);
      }
      if (!(buffer instanceof Buffer)) {
        throw new TypeError("Not a string or buffer");
      }
      let flushFlag = engine._finishFlushFlag;
      if (flushFlag == null) {
        flushFlag = zlib.Z_FINISH;
      }
      return engine._processChunk(buffer, flushFlag);
    }
    function inflateSync(buffer, opts) {
      return zlibBufferSync(new Inflate(opts), buffer);
    }
    module2.exports = exports2 = inflateSync;
    exports2.Inflate = Inflate;
    exports2.createInflate = createInflate;
    exports2.inflateSync = inflateSync;
  }
});

// node_modules/pngjs/lib/sync-reader.js
var require_sync_reader = __commonJS({
  "node_modules/pngjs/lib/sync-reader.js"(exports2, module2) {
    "use strict";
    var SyncReader = module2.exports = function(buffer) {
      this._buffer = buffer;
      this._reads = [];
    };
    SyncReader.prototype.read = function(length, callback) {
      this._reads.push({
        length: Math.abs(length),
        // if length < 0 then at most this length
        allowLess: length < 0,
        func: callback
      });
    };
    SyncReader.prototype.process = function() {
      while (this._reads.length > 0 && this._buffer.length) {
        let read = this._reads[0];
        if (this._buffer.length && (this._buffer.length >= read.length || read.allowLess)) {
          this._reads.shift();
          let buf = this._buffer;
          this._buffer = buf.slice(read.length);
          read.func.call(this, buf.slice(0, read.length));
        } else {
          break;
        }
      }
      if (this._reads.length > 0) {
        throw new Error("There are some read requests waitng on finished stream");
      }
      if (this._buffer.length > 0) {
        throw new Error("unrecognised content at end of stream");
      }
    };
  }
});

// node_modules/pngjs/lib/filter-parse-sync.js
var require_filter_parse_sync = __commonJS({
  "node_modules/pngjs/lib/filter-parse-sync.js"(exports2) {
    "use strict";
    var SyncReader = require_sync_reader();
    var Filter = require_filter_parse();
    exports2.process = function(inBuffer, bitmapInfo) {
      let outBuffers = [];
      let reader = new SyncReader(inBuffer);
      let filter = new Filter(bitmapInfo, {
        read: reader.read.bind(reader),
        write: function(bufferPart) {
          outBuffers.push(bufferPart);
        },
        complete: function() {
        }
      });
      filter.start();
      reader.process();
      return Buffer.concat(outBuffers);
    };
  }
});

// node_modules/pngjs/lib/parser-sync.js
var require_parser_sync = __commonJS({
  "node_modules/pngjs/lib/parser-sync.js"(exports2, module2) {
    "use strict";
    var hasSyncZlib = true;
    var zlib = require("zlib");
    var inflateSync = require_sync_inflate();
    if (!zlib.deflateSync) {
      hasSyncZlib = false;
    }
    var SyncReader = require_sync_reader();
    var FilterSync = require_filter_parse_sync();
    var Parser = require_parser();
    var bitmapper = require_bitmapper();
    var formatNormaliser = require_format_normaliser();
    module2.exports = function(buffer, options) {
      if (!hasSyncZlib) {
        throw new Error(
          "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
        );
      }
      let err;
      function handleError(_err_) {
        err = _err_;
      }
      let metaData;
      function handleMetaData(_metaData_) {
        metaData = _metaData_;
      }
      function handleTransColor(transColor) {
        metaData.transColor = transColor;
      }
      function handlePalette(palette) {
        metaData.palette = palette;
      }
      function handleSimpleTransparency() {
        metaData.alpha = true;
      }
      let gamma;
      function handleGamma(_gamma_) {
        gamma = _gamma_;
      }
      let inflateDataList = [];
      function handleInflateData(inflatedData2) {
        inflateDataList.push(inflatedData2);
      }
      let reader = new SyncReader(buffer);
      let parser = new Parser(options, {
        read: reader.read.bind(reader),
        error: handleError,
        metadata: handleMetaData,
        gamma: handleGamma,
        palette: handlePalette,
        transColor: handleTransColor,
        inflateData: handleInflateData,
        simpleTransparency: handleSimpleTransparency
      });
      parser.start();
      reader.process();
      if (err) {
        throw err;
      }
      let inflateData = Buffer.concat(inflateDataList);
      inflateDataList.length = 0;
      let inflatedData;
      if (metaData.interlace) {
        inflatedData = zlib.inflateSync(inflateData);
      } else {
        let rowSize = (metaData.width * metaData.bpp * metaData.depth + 7 >> 3) + 1;
        let imageSize = rowSize * metaData.height;
        inflatedData = inflateSync(inflateData, {
          chunkSize: imageSize,
          maxLength: imageSize
        });
      }
      inflateData = null;
      if (!inflatedData || !inflatedData.length) {
        throw new Error("bad png - invalid inflate data response");
      }
      let unfilteredData = FilterSync.process(inflatedData, metaData);
      inflateData = null;
      let bitmapData = bitmapper.dataToBitMap(unfilteredData, metaData);
      unfilteredData = null;
      let normalisedBitmapData = formatNormaliser(
        bitmapData,
        metaData,
        options.skipRescale
      );
      metaData.data = normalisedBitmapData;
      metaData.gamma = gamma || 0;
      return metaData;
    };
  }
});

// node_modules/pngjs/lib/packer-sync.js
var require_packer_sync = __commonJS({
  "node_modules/pngjs/lib/packer-sync.js"(exports2, module2) {
    "use strict";
    var hasSyncZlib = true;
    var zlib = require("zlib");
    if (!zlib.deflateSync) {
      hasSyncZlib = false;
    }
    var constants = require_constants();
    var Packer = require_packer();
    module2.exports = function(metaData, opt) {
      if (!hasSyncZlib) {
        throw new Error(
          "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
        );
      }
      let options = opt || {};
      let packer = new Packer(options);
      let chunks = [];
      chunks.push(Buffer.from(constants.PNG_SIGNATURE));
      chunks.push(packer.packIHDR(metaData.width, metaData.height));
      if (metaData.gamma) {
        chunks.push(packer.packGAMA(metaData.gamma));
      }
      let filteredData = packer.filterData(
        metaData.data,
        metaData.width,
        metaData.height
      );
      let compressedData = zlib.deflateSync(
        filteredData,
        packer.getDeflateOptions()
      );
      filteredData = null;
      if (!compressedData || !compressedData.length) {
        throw new Error("bad png - invalid compressed data response");
      }
      chunks.push(packer.packIDAT(compressedData));
      chunks.push(packer.packIEND());
      return Buffer.concat(chunks);
    };
  }
});

// node_modules/pngjs/lib/png-sync.js
var require_png_sync = __commonJS({
  "node_modules/pngjs/lib/png-sync.js"(exports2) {
    "use strict";
    var parse = require_parser_sync();
    var pack = require_packer_sync();
    exports2.read = function(buffer, options) {
      return parse(buffer, options || {});
    };
    exports2.write = function(png, options) {
      return pack(png, options);
    };
  }
});

// node_modules/pngjs/lib/png.js
var require_png = __commonJS({
  "node_modules/pngjs/lib/png.js"(exports2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var Parser = require_parser_async();
    var Packer = require_packer_async();
    var PNGSync = require_png_sync();
    var PNG2 = exports2.PNG = function(options) {
      Stream.call(this);
      options = options || {};
      this.width = options.width | 0;
      this.height = options.height | 0;
      this.data = this.width > 0 && this.height > 0 ? Buffer.alloc(4 * this.width * this.height) : null;
      if (options.fill && this.data) {
        this.data.fill(0);
      }
      this.gamma = 0;
      this.readable = this.writable = true;
      this._parser = new Parser(options);
      this._parser.on("error", this.emit.bind(this, "error"));
      this._parser.on("close", this._handleClose.bind(this));
      this._parser.on("metadata", this._metadata.bind(this));
      this._parser.on("gamma", this._gamma.bind(this));
      this._parser.on(
        "parsed",
        function(data) {
          this.data = data;
          this.emit("parsed", data);
        }.bind(this)
      );
      this._packer = new Packer(options);
      this._packer.on("data", this.emit.bind(this, "data"));
      this._packer.on("end", this.emit.bind(this, "end"));
      this._parser.on("close", this._handleClose.bind(this));
      this._packer.on("error", this.emit.bind(this, "error"));
    };
    util.inherits(PNG2, Stream);
    PNG2.sync = PNGSync;
    PNG2.prototype.pack = function() {
      if (!this.data || !this.data.length) {
        this.emit("error", "No data provided");
        return this;
      }
      process.nextTick(
        function() {
          this._packer.pack(this.data, this.width, this.height, this.gamma);
        }.bind(this)
      );
      return this;
    };
    PNG2.prototype.parse = function(data, callback) {
      if (callback) {
        let onParsed, onError;
        onParsed = function(parsedData) {
          this.removeListener("error", onError);
          this.data = parsedData;
          callback(null, this);
        }.bind(this);
        onError = function(err) {
          this.removeListener("parsed", onParsed);
          callback(err, null);
        }.bind(this);
        this.once("parsed", onParsed);
        this.once("error", onError);
      }
      this.end(data);
      return this;
    };
    PNG2.prototype.write = function(data) {
      this._parser.write(data);
      return true;
    };
    PNG2.prototype.end = function(data) {
      this._parser.end(data);
    };
    PNG2.prototype._metadata = function(metadata) {
      this.width = metadata.width;
      this.height = metadata.height;
      this.emit("metadata", metadata);
    };
    PNG2.prototype._gamma = function(gamma) {
      this.gamma = gamma;
    };
    PNG2.prototype._handleClose = function() {
      if (!this._parser.writable && !this._packer.readable) {
        this.emit("close");
      }
    };
    PNG2.bitblt = function(src, dst, srcX, srcY, width, height, deltaX, deltaY) {
      srcX |= 0;
      srcY |= 0;
      width |= 0;
      height |= 0;
      deltaX |= 0;
      deltaY |= 0;
      if (srcX > src.width || srcY > src.height || srcX + width > src.width || srcY + height > src.height) {
        throw new Error("bitblt reading outside image");
      }
      if (deltaX > dst.width || deltaY > dst.height || deltaX + width > dst.width || deltaY + height > dst.height) {
        throw new Error("bitblt writing outside image");
      }
      for (let y = 0; y < height; y++) {
        src.data.copy(
          dst.data,
          (deltaY + y) * dst.width + deltaX << 2,
          (srcY + y) * src.width + srcX << 2,
          (srcY + y) * src.width + srcX + width << 2
        );
      }
    };
    PNG2.prototype.bitblt = function(dst, srcX, srcY, width, height, deltaX, deltaY) {
      PNG2.bitblt(this, dst, srcX, srcY, width, height, deltaX, deltaY);
      return this;
    };
    PNG2.adjustGamma = function(src) {
      if (src.gamma) {
        for (let y = 0; y < src.height; y++) {
          for (let x = 0; x < src.width; x++) {
            let idx = src.width * y + x << 2;
            for (let i = 0; i < 3; i++) {
              let sample = src.data[idx + i] / 255;
              sample = Math.pow(sample, 1 / 2.2 / src.gamma);
              src.data[idx + i] = Math.round(sample * 255);
            }
          }
        }
        src.gamma = 0;
      }
    };
    PNG2.prototype.adjustGamma = function() {
      PNG2.adjustGamma(this);
    };
  }
});

// source/importer/sliced-png.ts
var sliced_png_exports = {};
__export(sliced_png_exports, {
  compactSlicePng: () => compactSlicePng,
  writeSlicedPng: () => writeSlicedPng
});
module.exports = __toCommonJS(sliced_png_exports);
var import_pngjs = __toESM(require_png());
var SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
var MAX_PIXELS = 16 * 1024 * 1024;
var MAX_BYTES = 64 * 1024 * 1024;
var COLOR_CHUNKS = /* @__PURE__ */ new Set(["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"]);
function inspectPng(contents) {
  if (contents.length < 45 || contents.length > MAX_BYTES || !contents.subarray(0, 8).equals(SIGNATURE) || contents.readUInt32BE(8) !== 13 || contents.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG \u683C\u5F0F\u65E0\u6548\u6216\u6587\u4EF6\u8FC7\u5927\uFF0C\u4FDD\u7559\u5B8C\u6574\u56FE\u7247");
  }
  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS) throw new Error("\u56FE\u7247\u8D85\u8FC7\u5B89\u5168\u5904\u7406\u50CF\u7D20\u4E0A\u9650\uFF0C\u4FDD\u7559\u5B8C\u6574\u56FE\u7247");
  if (contents[24] > 8) throw new Error("\u9AD8\u4F4D\u6DF1 PNG \u4E0D\u8FDB\u884C\u964D\u7CBE\u5EA6\u5904\u7406");
  const metadata = [];
  let ended = false;
  for (let offset = 8; offset < contents.length; ) {
    if (offset + 12 > contents.length) throw new Error("PNG \u6570\u636E\u4E0D\u5B8C\u6574");
    const end = offset + 12 + contents.readUInt32BE(offset);
    if (end > contents.length) throw new Error("PNG \u6570\u636E\u4E0D\u5B8C\u6574");
    const kind = contents.toString("ascii", offset + 4, offset + 8);
    if (["acTL", "fcTL", "fdAT", "sBIT"].includes(kind)) throw new Error("\u7279\u6B8A PNG \u5143\u6570\u636E\u6682\u4E0D\u652F\u6301\u6700\u5C0F\u5316");
    if (COLOR_CHUNKS.has(kind)) metadata.push(contents.subarray(offset, end));
    offset = end;
    if (kind === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended) throw new Error("PNG \u6570\u636E\u4E0D\u5B8C\u6574");
  return { width, height, metadata };
}
function axisAligned(node) {
  const rotation = node.rotation ?? 0;
  if (!Number.isFinite(rotation) || Math.abs(rotation) > 0.01) return false;
  const matrix = node.relativeTransform;
  return !matrix || matrix.length >= 2 && matrix[0].length >= 2 && matrix[1].length >= 2 && [matrix[0][0], matrix[0][1], matrix[1][0], matrix[1][1]].every(Number.isFinite) && matrix[0][0] > 0 && matrix[1][1] > 0 && Math.abs(matrix[0][1]) <= 1e-6 && Math.abs(matrix[1][0]) <= 1e-6;
}
function repeatedBand(image, start, end, horizontal) {
  const stride = image.width * 4;
  if (!horizontal) {
    const first = image.data.subarray(start * stride, (start + 1) * stride);
    for (let y = start + 1; y < end; y++) {
      if (!first.equals(image.data.subarray(y * stride, (y + 1) * stride))) return false;
    }
  } else {
    for (let y = 0; y < image.height; y++) {
      const first = image.data.readUInt32LE(y * stride + start * 4);
      for (let x = start + 1; x < end; x++) {
        if (image.data.readUInt32LE(y * stride + x * 4) !== first) return false;
      }
    }
  }
  return true;
}
function segments(length, before, after, keep, shrink) {
  if (!shrink) return [{ start: 0, size: length }];
  return [
    { start: 0, size: before },
    { start: before + Math.floor((length - before - after - keep) / 2), size: keep },
    { start: length - after, size: after }
  ];
}
function compactSlicePng(contents, node, analysis, scale) {
  const borders = Object.fromEntries(Object.entries(analysis.borders).map(([key, value]) => [key, Math.max(0, Math.round(value * scale))]));
  const optimization = {
    status: "skipped",
    reason: "",
    sourceBytes: contents.length,
    bytes: contents.length
  };
  const unchanged = (reason, status = "skipped") => ({
    contents,
    borders,
    optimization: { ...optimization, status, reason }
  });
  try {
    if (!Number.isFinite(scale) || scale <= 0 || !axisAligned(node)) {
      return unchanged("\u65CB\u8F6C\u3001\u7FFB\u8F6C\u6216\u65E0\u6548\u500D\u7387\u7684\u5207\u7247\u4FDD\u7559\u5B8C\u6574\u56FE\u7247");
    }
    const frame = node.absoluteBoundingBox;
    const header = inspectPng(contents);
    Object.assign(optimization, {
      sourceWidth: header.width,
      sourceHeight: header.height,
      width: header.width,
      height: header.height
    });
    if (!frame || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0 || Math.abs(header.width - frame.width * scale) > 1 || Math.abs(header.height - frame.height * scale) > 1) {
      return unchanged("\u56FE\u7247\u5C3A\u5BF8\u4E0E\u5207\u7247\u753B\u5E03\u4E0D\u5339\u914D\uFF0C\u4FDD\u7559\u5B8C\u6574\u56FE\u7247");
    }
    const horizontal = analysis.mode !== "vertical";
    const vertical = analysis.mode !== "horizontal";
    if (!["horizontal", "vertical", "nine"].includes(analysis.mode) || Object.values(analysis.borders).some((value) => !Number.isFinite(value) || value < 0) || horizontal && (borders.left <= 0 || borders.right <= 0 || borders.left + borders.right >= header.width) || vertical && (borders.top <= 0 || borders.bottom <= 0 || borders.top + borders.bottom >= header.height)) {
      return unchanged("\u5207\u7247\u50CF\u7D20\u8FB9\u754C\u65E0\u6548\uFF0C\u4FDD\u7559\u5B8C\u6574\u56FE\u7247");
    }
    const keep = Math.max(1, Math.round(2 * scale));
    const canShrinkX = horizontal && header.width - borders.left - borders.right > keep;
    const canShrinkY = vertical && header.height - borders.top - borders.bottom > keep;
    if (!canShrinkX && !canShrinkY) return unchanged("\u4E2D\u5FC3\u533A\u57DF\u5DF2\u8DB3\u591F\u5C0F", "unchanged");
    const image = import_pngjs.PNG.sync.read(contents, { checkCRC: true });
    const shrinkX = canShrinkX && repeatedBand(image, borders.left, image.width - borders.right, true);
    const shrinkY = canShrinkY && repeatedBand(image, borders.top, image.height - borders.bottom, false);
    if (!shrinkX && !shrinkY) return unchanged("\u4E2D\u5FC3\u6216\u8FB9\u5E26\u542B\u975E\u91CD\u590D\u50CF\u7D20\uFF0C\u4E3A\u4FDD\u7559\u56FE\u6848/\u6E10\u53D8\u4E0D\u7F29\u5C0F", "unchanged");
    const columns = segments(image.width, borders.left, borders.right, keep, shrinkX);
    const rows = segments(image.height, borders.top, borders.bottom, keep, shrinkY);
    const output = new import_pngjs.PNG({
      width: columns.reduce((sum, item) => sum + item.size, 0),
      height: rows.reduce((sum, item) => sum + item.size, 0)
    });
    let targetY = 0;
    for (const row of rows) {
      let targetX = 0;
      for (const column of columns) {
        for (let y = 0; y < row.size; y++) {
          const offset = ((row.start + y) * image.width + column.start) * 4;
          image.data.copy(
            output.data,
            ((targetY + y) * output.width + targetX) * 4,
            offset,
            offset + column.size * 4
          );
        }
        targetX += column.size;
      }
      targetY += row.size;
    }
    const encoded = import_pngjs.PNG.sync.write(output);
    const result = header.metadata.length ? Buffer.concat([encoded.subarray(0, 33), ...header.metadata, encoded.subarray(33)]) : encoded;
    return { contents: result, borders, optimization: {
      ...optimization,
      status: "compacted",
      reason: shrinkX && shrinkY ? "\u6A2A\u7EB5\u4E2D\u5FC3\u5E26\u6700\u5C0F\u5316" : shrinkX ? "\u4EC5\u6A2A\u5411\u4E2D\u5FC3\u5E26\u6700\u5C0F\u5316" : "\u4EC5\u7EB5\u5411\u4E2D\u5FC3\u5E26\u6700\u5C0F\u5316",
      width: output.width,
      height: output.height,
      bytes: result.length
    } };
  } catch (error) {
    return unchanged(error instanceof Error ? error.message : "PNG \u6700\u5C0F\u5316\u5931\u8D25\uFF0C\u4FDD\u7559\u5B8C\u6574\u56FE\u7247");
  }
}
async function writeSlicedPng(writer, url, contents, node, analysis, scale) {
  const compact = compactSlicePng(contents, node, analysis, scale);
  let asset;
  try {
    asset = await writer.write(url, compact.contents, compact.borders);
  } catch (error) {
    if (compact.optimization.status === "compacted") {
      try {
        await writer.write(url, contents, compact.borders);
      } catch (restoreError) {
        throw new Error(`\u4E5D\u5BAB\u5C0F\u56FE\u5199\u5165\u5931\u8D25\uFF0C\u5B8C\u6574 PNG \u6062\u590D\u4E5F\u5931\u8D25\uFF1A${String(error)}\uFF1B${String(restoreError)}`);
      }
    }
    throw error;
  }
  if (compact.optimization.status === "compacted" && (!asset.sliced || asset.sliceFallback)) {
    asset = await writer.write(url, contents, compact.borders);
    return { asset, optimization: {
      ...compact.optimization,
      status: "restored",
      reason: "\u5C0F\u56FE\u4E5D\u5BAB\u8FB9\u8DDD\u672A\u80FD\u786E\u8BA4\uFF0C\u5DF2\u6062\u590D\u5B8C\u6574 PNG",
      width: compact.optimization.sourceWidth,
      height: compact.optimization.sourceHeight,
      bytes: contents.length
    } };
  }
  return { asset, optimization: compact.optimization };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  compactSlicePng,
  writeSlicedPng
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9jaHVua3N0cmVhbS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ludGVybGFjZS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BhZXRoLXByZWRpY3Rvci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS1hc3luYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2NvbnN0YW50cy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2NyYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BhcnNlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2JpdG1hcHBlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2Zvcm1hdC1ub3JtYWxpc2VyLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcGFyc2VyLWFzeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvYml0cGFja2VyLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvZmlsdGVyLXBhY2suanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXIuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXItYXN5bmMuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9zeW5jLWluZmxhdGUuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9zeW5jLXJlYWRlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS1zeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcGFyc2VyLXN5bmMuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXItc3luYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BuZy1zeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcG5nLmpzIiwgIi4uLy4uL3NvdXJjZS9pbXBvcnRlci9zbGljZWQtcG5nLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJcInVzZSBzdHJpY3RcIjtcblxubGV0IHV0aWwgPSByZXF1aXJlKFwidXRpbFwiKTtcbmxldCBTdHJlYW0gPSByZXF1aXJlKFwic3RyZWFtXCIpO1xuXG5sZXQgQ2h1bmtTdHJlYW0gPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoKSB7XG4gIFN0cmVhbS5jYWxsKHRoaXMpO1xuXG4gIHRoaXMuX2J1ZmZlcnMgPSBbXTtcbiAgdGhpcy5fYnVmZmVyZWQgPSAwO1xuXG4gIHRoaXMuX3JlYWRzID0gW107XG4gIHRoaXMuX3BhdXNlZCA9IGZhbHNlO1xuXG4gIHRoaXMuX2VuY29kaW5nID0gXCJ1dGY4XCI7XG4gIHRoaXMud3JpdGFibGUgPSB0cnVlO1xufSk7XG51dGlsLmluaGVyaXRzKENodW5rU3RyZWFtLCBTdHJlYW0pO1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUucmVhZCA9IGZ1bmN0aW9uIChsZW5ndGgsIGNhbGxiYWNrKSB7XG4gIHRoaXMuX3JlYWRzLnB1c2goe1xuICAgIGxlbmd0aDogTWF0aC5hYnMobGVuZ3RoKSwgLy8gaWYgbGVuZ3RoIDwgMCB0aGVuIGF0IG1vc3QgdGhpcyBsZW5ndGhcbiAgICBhbGxvd0xlc3M6IGxlbmd0aCA8IDAsXG4gICAgZnVuYzogY2FsbGJhY2ssXG4gIH0pO1xuXG4gIHByb2Nlc3MubmV4dFRpY2soXG4gICAgZnVuY3Rpb24gKCkge1xuICAgICAgdGhpcy5fcHJvY2VzcygpO1xuXG4gICAgICAvLyBpdHMgcGF1c2VkIGFuZCB0aGVyZSBpcyBub3QgZW5vdWdodCBkYXRhIHRoZW4gYXNrIGZvciBtb3JlXG4gICAgICBpZiAodGhpcy5fcGF1c2VkICYmIHRoaXMuX3JlYWRzICYmIHRoaXMuX3JlYWRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGhpcy5fcGF1c2VkID0gZmFsc2U7XG5cbiAgICAgICAgdGhpcy5lbWl0KFwiZHJhaW5cIik7XG4gICAgICB9XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG59O1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbiAoZGF0YSwgZW5jb2RpbmcpIHtcbiAgaWYgKCF0aGlzLndyaXRhYmxlKSB7XG4gICAgdGhpcy5lbWl0KFwiZXJyb3JcIiwgbmV3IEVycm9yKFwiU3RyZWFtIG5vdCB3cml0YWJsZVwiKSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgbGV0IGRhdGFCdWZmZXI7XG4gIGlmIChCdWZmZXIuaXNCdWZmZXIoZGF0YSkpIHtcbiAgICBkYXRhQnVmZmVyID0gZGF0YTtcbiAgfSBlbHNlIHtcbiAgICBkYXRhQnVmZmVyID0gQnVmZmVyLmZyb20oZGF0YSwgZW5jb2RpbmcgfHwgdGhpcy5fZW5jb2RpbmcpO1xuICB9XG5cbiAgdGhpcy5fYnVmZmVycy5wdXNoKGRhdGFCdWZmZXIpO1xuICB0aGlzLl9idWZmZXJlZCArPSBkYXRhQnVmZmVyLmxlbmd0aDtcblxuICB0aGlzLl9wcm9jZXNzKCk7XG5cbiAgLy8gb2sgaWYgdGhlcmUgYXJlIG5vIG1vcmUgcmVhZCByZXF1ZXN0c1xuICBpZiAodGhpcy5fcmVhZHMgJiYgdGhpcy5fcmVhZHMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhpcy5fcGF1c2VkID0gdHJ1ZTtcbiAgfVxuXG4gIHJldHVybiB0aGlzLndyaXRhYmxlICYmICF0aGlzLl9wYXVzZWQ7XG59O1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUuZW5kID0gZnVuY3Rpb24gKGRhdGEsIGVuY29kaW5nKSB7XG4gIGlmIChkYXRhKSB7XG4gICAgdGhpcy53cml0ZShkYXRhLCBlbmNvZGluZyk7XG4gIH1cblxuICB0aGlzLndyaXRhYmxlID0gZmFsc2U7XG5cbiAgLy8gYWxyZWFkeSBkZXN0cm95ZWRcbiAgaWYgKCF0aGlzLl9idWZmZXJzKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gZW5xdWV1ZSBvciBoYW5kbGUgZW5kXG4gIGlmICh0aGlzLl9idWZmZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRoaXMuX2VuZCgpO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX2J1ZmZlcnMucHVzaChudWxsKTtcbiAgICB0aGlzLl9wcm9jZXNzKCk7XG4gIH1cbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5kZXN0cm95U29vbiA9IENodW5rU3RyZWFtLnByb3RvdHlwZS5lbmQ7XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5fZW5kID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5fcmVhZHMubGVuZ3RoID4gMCkge1xuICAgIHRoaXMuZW1pdChcImVycm9yXCIsIG5ldyBFcnJvcihcIlVuZXhwZWN0ZWQgZW5kIG9mIGlucHV0XCIpKTtcbiAgfVxuXG4gIHRoaXMuZGVzdHJveSgpO1xufTtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLmRlc3Ryb3kgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5fYnVmZmVycykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMud3JpdGFibGUgPSBmYWxzZTtcbiAgdGhpcy5fcmVhZHMgPSBudWxsO1xuICB0aGlzLl9idWZmZXJzID0gbnVsbDtcblxuICB0aGlzLmVtaXQoXCJjbG9zZVwiKTtcbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5fcHJvY2Vzc1JlYWRBbGxvd2luZ0xlc3MgPSBmdW5jdGlvbiAocmVhZCkge1xuICAvLyBvayB0aGVyZSBpcyBhbnkgZGF0YSBzbyB0aGF0IHdlIGNhbiBzYXRpc2Z5IHRoaXMgcmVxdWVzdFxuICB0aGlzLl9yZWFkcy5zaGlmdCgpOyAvLyA9PSByZWFkXG5cbiAgLy8gZmlyc3Qgd2UgbmVlZCB0byBwZWVrIGludG8gZmlyc3QgYnVmZmVyXG4gIGxldCBzbWFsbGVyQnVmID0gdGhpcy5fYnVmZmVyc1swXTtcblxuICAvLyBvayB0aGVyZSBpcyBtb3JlIGRhdGEgdGhhbiB3ZSBuZWVkXG4gIGlmIChzbWFsbGVyQnVmLmxlbmd0aCA+IHJlYWQubGVuZ3RoKSB7XG4gICAgdGhpcy5fYnVmZmVyZWQgLT0gcmVhZC5sZW5ndGg7XG4gICAgdGhpcy5fYnVmZmVyc1swXSA9IHNtYWxsZXJCdWYuc2xpY2UocmVhZC5sZW5ndGgpO1xuXG4gICAgcmVhZC5mdW5jLmNhbGwodGhpcywgc21hbGxlckJ1Zi5zbGljZSgwLCByZWFkLmxlbmd0aCkpO1xuICB9IGVsc2Uge1xuICAgIC8vIG9rIHRoaXMgaXMgbGVzcyB0aGFuIG1heGltdW0gbGVuZ3RoIHNvIHVzZSBpdCBhbGxcbiAgICB0aGlzLl9idWZmZXJlZCAtPSBzbWFsbGVyQnVmLmxlbmd0aDtcbiAgICB0aGlzLl9idWZmZXJzLnNoaWZ0KCk7IC8vID09IHNtYWxsZXJCdWZcblxuICAgIHJlYWQuZnVuYy5jYWxsKHRoaXMsIHNtYWxsZXJCdWYpO1xuICB9XG59O1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUuX3Byb2Nlc3NSZWFkID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgdGhpcy5fcmVhZHMuc2hpZnQoKTsgLy8gPT0gcmVhZFxuXG4gIGxldCBwb3MgPSAwO1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgZGF0YSA9IEJ1ZmZlci5hbGxvYyhyZWFkLmxlbmd0aCk7XG5cbiAgLy8gY3JlYXRlIGJ1ZmZlciBmb3IgYWxsIGRhdGFcbiAgd2hpbGUgKHBvcyA8IHJlYWQubGVuZ3RoKSB7XG4gICAgbGV0IGJ1ZiA9IHRoaXMuX2J1ZmZlcnNbY291bnQrK107XG4gICAgbGV0IGxlbiA9IE1hdGgubWluKGJ1Zi5sZW5ndGgsIHJlYWQubGVuZ3RoIC0gcG9zKTtcblxuICAgIGJ1Zi5jb3B5KGRhdGEsIHBvcywgMCwgbGVuKTtcbiAgICBwb3MgKz0gbGVuO1xuXG4gICAgLy8gbGFzdCBidWZmZXIgd2Fzbid0IHVzZWQgYWxsIHNvIGp1c3Qgc2xpY2UgaXQgYW5kIGxlYXZlXG4gICAgaWYgKGxlbiAhPT0gYnVmLmxlbmd0aCkge1xuICAgICAgdGhpcy5fYnVmZmVyc1stLWNvdW50XSA9IGJ1Zi5zbGljZShsZW4pO1xuICAgIH1cbiAgfVxuXG4gIC8vIHJlbW92ZSBhbGwgdXNlZCBidWZmZXJzXG4gIGlmIChjb3VudCA+IDApIHtcbiAgICB0aGlzLl9idWZmZXJzLnNwbGljZSgwLCBjb3VudCk7XG4gIH1cblxuICB0aGlzLl9idWZmZXJlZCAtPSByZWFkLmxlbmd0aDtcblxuICByZWFkLmZ1bmMuY2FsbCh0aGlzLCBkYXRhKTtcbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5fcHJvY2VzcyA9IGZ1bmN0aW9uICgpIHtcbiAgdHJ5IHtcbiAgICAvLyBhcyBsb25nIGFzIHRoZXJlIGlzIGFueSBkYXRhIGFuZCByZWFkIHJlcXVlc3RzXG4gICAgd2hpbGUgKHRoaXMuX2J1ZmZlcmVkID4gMCAmJiB0aGlzLl9yZWFkcyAmJiB0aGlzLl9yZWFkcy5sZW5ndGggPiAwKSB7XG4gICAgICBsZXQgcmVhZCA9IHRoaXMuX3JlYWRzWzBdO1xuXG4gICAgICAvLyByZWFkIGFueSBkYXRhIChidXQgbm8gbW9yZSB0aGFuIGxlbmd0aClcbiAgICAgIGlmIChyZWFkLmFsbG93TGVzcykge1xuICAgICAgICB0aGlzLl9wcm9jZXNzUmVhZEFsbG93aW5nTGVzcyhyZWFkKTtcbiAgICAgIH0gZWxzZSBpZiAodGhpcy5fYnVmZmVyZWQgPj0gcmVhZC5sZW5ndGgpIHtcbiAgICAgICAgLy8gb2sgd2UgY2FuIG1lZXQgc29tZSBleHBlY3RhdGlvbnNcblxuICAgICAgICB0aGlzLl9wcm9jZXNzUmVhZChyZWFkKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIG5vdCBlbm91Z2h0IGRhdGEgdG8gc2F0aXNmeSBmaXJzdCByZXF1ZXN0IGluIHF1ZXVlXG4gICAgICAgIC8vIHNvIHdlIG5lZWQgdG8gd2FpdCBmb3IgbW9yZVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5fYnVmZmVycyAmJiAhdGhpcy53cml0YWJsZSkge1xuICAgICAgdGhpcy5fZW5kKCk7XG4gICAgfVxuICB9IGNhdGNoIChleCkge1xuICAgIHRoaXMuZW1pdChcImVycm9yXCIsIGV4KTtcbiAgfVxufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxuLy8gQWRhbSA3XG4vLyAgIDAgMSAyIDMgNCA1IDYgN1xuLy8gMCB4IDYgNCA2IHggNiA0IDZcbi8vIDEgNyA3IDcgNyA3IDcgNyA3XG4vLyAyIDUgNiA1IDYgNSA2IDUgNlxuLy8gMyA3IDcgNyA3IDcgNyA3IDdcbi8vIDQgMyA2IDQgNiAzIDYgNCA2XG4vLyA1IDcgNyA3IDcgNyA3IDcgN1xuLy8gNiA1IDYgNSA2IDUgNiA1IDZcbi8vIDcgNyA3IDcgNyA3IDcgNyA3XG5cbmxldCBpbWFnZVBhc3NlcyA9IFtcbiAge1xuICAgIC8vIHBhc3MgMSAtIDFweFxuICAgIHg6IFswXSxcbiAgICB5OiBbMF0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDIgLSAxcHhcbiAgICB4OiBbNF0sXG4gICAgeTogWzBdLFxuICB9LFxuICB7XG4gICAgLy8gcGFzcyAzIC0gMnB4XG4gICAgeDogWzAsIDRdLFxuICAgIHk6IFs0XSxcbiAgfSxcbiAge1xuICAgIC8vIHBhc3MgNCAtIDRweFxuICAgIHg6IFsyLCA2XSxcbiAgICB5OiBbMCwgNF0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDUgLSA4cHhcbiAgICB4OiBbMCwgMiwgNCwgNl0sXG4gICAgeTogWzIsIDZdLFxuICB9LFxuICB7XG4gICAgLy8gcGFzcyA2IC0gMTZweFxuICAgIHg6IFsxLCAzLCA1LCA3XSxcbiAgICB5OiBbMCwgMiwgNCwgNl0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDcgLSAzMnB4XG4gICAgeDogWzAsIDEsIDIsIDMsIDQsIDUsIDYsIDddLFxuICAgIHk6IFsxLCAzLCA1LCA3XSxcbiAgfSxcbl07XG5cbmV4cG9ydHMuZ2V0SW1hZ2VQYXNzZXMgPSBmdW5jdGlvbiAod2lkdGgsIGhlaWdodCkge1xuICBsZXQgaW1hZ2VzID0gW107XG4gIGxldCB4TGVmdE92ZXIgPSB3aWR0aCAlIDg7XG4gIGxldCB5TGVmdE92ZXIgPSBoZWlnaHQgJSA4O1xuICBsZXQgeFJlcGVhdHMgPSAod2lkdGggLSB4TGVmdE92ZXIpIC8gODtcbiAgbGV0IHlSZXBlYXRzID0gKGhlaWdodCAtIHlMZWZ0T3ZlcikgLyA4O1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGltYWdlUGFzc2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgbGV0IHBhc3MgPSBpbWFnZVBhc3Nlc1tpXTtcbiAgICBsZXQgcGFzc1dpZHRoID0geFJlcGVhdHMgKiBwYXNzLngubGVuZ3RoO1xuICAgIGxldCBwYXNzSGVpZ2h0ID0geVJlcGVhdHMgKiBwYXNzLnkubGVuZ3RoO1xuICAgIGZvciAobGV0IGogPSAwOyBqIDwgcGFzcy54Lmxlbmd0aDsgaisrKSB7XG4gICAgICBpZiAocGFzcy54W2pdIDwgeExlZnRPdmVyKSB7XG4gICAgICAgIHBhc3NXaWR0aCsrO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGZvciAobGV0IGogPSAwOyBqIDwgcGFzcy55Lmxlbmd0aDsgaisrKSB7XG4gICAgICBpZiAocGFzcy55W2pdIDwgeUxlZnRPdmVyKSB7XG4gICAgICAgIHBhc3NIZWlnaHQrKztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocGFzc1dpZHRoID4gMCAmJiBwYXNzSGVpZ2h0ID4gMCkge1xuICAgICAgaW1hZ2VzLnB1c2goeyB3aWR0aDogcGFzc1dpZHRoLCBoZWlnaHQ6IHBhc3NIZWlnaHQsIGluZGV4OiBpIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gaW1hZ2VzO1xufTtcblxuZXhwb3J0cy5nZXRJbnRlcmxhY2VJdGVyYXRvciA9IGZ1bmN0aW9uICh3aWR0aCkge1xuICByZXR1cm4gZnVuY3Rpb24gKHgsIHksIHBhc3MpIHtcbiAgICBsZXQgb3V0ZXJYTGVmdE92ZXIgPSB4ICUgaW1hZ2VQYXNzZXNbcGFzc10ueC5sZW5ndGg7XG4gICAgbGV0IG91dGVyWCA9XG4gICAgICAoKHggLSBvdXRlclhMZWZ0T3ZlcikgLyBpbWFnZVBhc3Nlc1twYXNzXS54Lmxlbmd0aCkgKiA4ICtcbiAgICAgIGltYWdlUGFzc2VzW3Bhc3NdLnhbb3V0ZXJYTGVmdE92ZXJdO1xuICAgIGxldCBvdXRlcllMZWZ0T3ZlciA9IHkgJSBpbWFnZVBhc3Nlc1twYXNzXS55Lmxlbmd0aDtcbiAgICBsZXQgb3V0ZXJZID1cbiAgICAgICgoeSAtIG91dGVyWUxlZnRPdmVyKSAvIGltYWdlUGFzc2VzW3Bhc3NdLnkubGVuZ3RoKSAqIDggK1xuICAgICAgaW1hZ2VQYXNzZXNbcGFzc10ueVtvdXRlcllMZWZ0T3Zlcl07XG4gICAgcmV0dXJuIG91dGVyWCAqIDQgKyBvdXRlclkgKiB3aWR0aCAqIDQ7XG4gIH07XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIHBhZXRoUHJlZGljdG9yKGxlZnQsIGFib3ZlLCB1cExlZnQpIHtcbiAgbGV0IHBhZXRoID0gbGVmdCArIGFib3ZlIC0gdXBMZWZ0O1xuICBsZXQgcExlZnQgPSBNYXRoLmFicyhwYWV0aCAtIGxlZnQpO1xuICBsZXQgcEFib3ZlID0gTWF0aC5hYnMocGFldGggLSBhYm92ZSk7XG4gIGxldCBwVXBMZWZ0ID0gTWF0aC5hYnMocGFldGggLSB1cExlZnQpO1xuXG4gIGlmIChwTGVmdCA8PSBwQWJvdmUgJiYgcExlZnQgPD0gcFVwTGVmdCkge1xuICAgIHJldHVybiBsZWZ0O1xuICB9XG4gIGlmIChwQWJvdmUgPD0gcFVwTGVmdCkge1xuICAgIHJldHVybiBhYm92ZTtcbiAgfVxuICByZXR1cm4gdXBMZWZ0O1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGludGVybGFjZVV0aWxzID0gcmVxdWlyZShcIi4vaW50ZXJsYWNlXCIpO1xubGV0IHBhZXRoUHJlZGljdG9yID0gcmVxdWlyZShcIi4vcGFldGgtcHJlZGljdG9yXCIpO1xuXG5mdW5jdGlvbiBnZXRCeXRlV2lkdGgod2lkdGgsIGJwcCwgZGVwdGgpIHtcbiAgbGV0IGJ5dGVXaWR0aCA9IHdpZHRoICogYnBwO1xuICBpZiAoZGVwdGggIT09IDgpIHtcbiAgICBieXRlV2lkdGggPSBNYXRoLmNlaWwoYnl0ZVdpZHRoIC8gKDggLyBkZXB0aCkpO1xuICB9XG4gIHJldHVybiBieXRlV2lkdGg7XG59XG5cbmxldCBGaWx0ZXIgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoYml0bWFwSW5mbywgZGVwZW5kZW5jaWVzKSB7XG4gIGxldCB3aWR0aCA9IGJpdG1hcEluZm8ud2lkdGg7XG4gIGxldCBoZWlnaHQgPSBiaXRtYXBJbmZvLmhlaWdodDtcbiAgbGV0IGludGVybGFjZSA9IGJpdG1hcEluZm8uaW50ZXJsYWNlO1xuICBsZXQgYnBwID0gYml0bWFwSW5mby5icHA7XG4gIGxldCBkZXB0aCA9IGJpdG1hcEluZm8uZGVwdGg7XG5cbiAgdGhpcy5yZWFkID0gZGVwZW5kZW5jaWVzLnJlYWQ7XG4gIHRoaXMud3JpdGUgPSBkZXBlbmRlbmNpZXMud3JpdGU7XG4gIHRoaXMuY29tcGxldGUgPSBkZXBlbmRlbmNpZXMuY29tcGxldGU7XG5cbiAgdGhpcy5faW1hZ2VJbmRleCA9IDA7XG4gIHRoaXMuX2ltYWdlcyA9IFtdO1xuICBpZiAoaW50ZXJsYWNlKSB7XG4gICAgbGV0IHBhc3NlcyA9IGludGVybGFjZVV0aWxzLmdldEltYWdlUGFzc2VzKHdpZHRoLCBoZWlnaHQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcGFzc2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLl9pbWFnZXMucHVzaCh7XG4gICAgICAgIGJ5dGVXaWR0aDogZ2V0Qnl0ZVdpZHRoKHBhc3Nlc1tpXS53aWR0aCwgYnBwLCBkZXB0aCksXG4gICAgICAgIGhlaWdodDogcGFzc2VzW2ldLmhlaWdodCxcbiAgICAgICAgbGluZUluZGV4OiAwLFxuICAgICAgfSk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHRoaXMuX2ltYWdlcy5wdXNoKHtcbiAgICAgIGJ5dGVXaWR0aDogZ2V0Qnl0ZVdpZHRoKHdpZHRoLCBicHAsIGRlcHRoKSxcbiAgICAgIGhlaWdodDogaGVpZ2h0LFxuICAgICAgbGluZUluZGV4OiAwLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gd2hlbiBmaWx0ZXJpbmcgdGhlIGxpbmUgd2UgbG9vayBhdCB0aGUgcGl4ZWwgdG8gdGhlIGxlZnRcbiAgLy8gdGhlIHNwZWMgYWxzbyBzYXlzIGl0IGlzIGRvbmUgb24gYSBieXRlIGxldmVsIHJlZ2FyZGxlc3Mgb2YgdGhlIG51bWJlciBvZiBwaXhlbHNcbiAgLy8gc28gaWYgdGhlIGRlcHRoIGlzIGJ5dGUgY29tcGF0aWJsZSAoOCBvciAxNikgd2Ugc3VidHJhY3QgdGhlIGJwcCBpbiBvcmRlciB0byBjb21wYXJlIGJhY2tcbiAgLy8gYSBwaXhlbCByYXRoZXIgdGhhbiBqdXN0IGEgZGlmZmVyZW50IGJ5dGUgcGFydC4gSG93ZXZlciBpZiB3ZSBhcmUgc3ViIGJ5dGUsIHdlIGlnbm9yZS5cbiAgaWYgKGRlcHRoID09PSA4KSB7XG4gICAgdGhpcy5feENvbXBhcmlzb24gPSBicHA7XG4gIH0gZWxzZSBpZiAoZGVwdGggPT09IDE2KSB7XG4gICAgdGhpcy5feENvbXBhcmlzb24gPSBicHAgKiAyO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX3hDb21wYXJpc29uID0gMTtcbiAgfVxufSk7XG5cbkZpbHRlci5wcm90b3R5cGUuc3RhcnQgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMucmVhZChcbiAgICB0aGlzLl9pbWFnZXNbdGhpcy5faW1hZ2VJbmRleF0uYnl0ZVdpZHRoICsgMSxcbiAgICB0aGlzLl9yZXZlcnNlRmlsdGVyTGluZS5iaW5kKHRoaXMpXG4gICk7XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl91bkZpbHRlclR5cGUxID0gZnVuY3Rpb24gKFxuICByYXdEYXRhLFxuICB1bmZpbHRlcmVkTGluZSxcbiAgYnl0ZVdpZHRoXG4pIHtcbiAgbGV0IHhDb21wYXJpc29uID0gdGhpcy5feENvbXBhcmlzb247XG4gIGxldCB4QmlnZ2VyVGhhbiA9IHhDb21wYXJpc29uIC0gMTtcblxuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IHJhd0J5dGUgPSByYXdEYXRhWzEgKyB4XTtcbiAgICBsZXQgZjFMZWZ0ID0geCA+IHhCaWdnZXJUaGFuID8gdW5maWx0ZXJlZExpbmVbeCAtIHhDb21wYXJpc29uXSA6IDA7XG4gICAgdW5maWx0ZXJlZExpbmVbeF0gPSByYXdCeXRlICsgZjFMZWZ0O1xuICB9XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl91bkZpbHRlclR5cGUyID0gZnVuY3Rpb24gKFxuICByYXdEYXRhLFxuICB1bmZpbHRlcmVkTGluZSxcbiAgYnl0ZVdpZHRoXG4pIHtcbiAgbGV0IGxhc3RMaW5lID0gdGhpcy5fbGFzdExpbmU7XG5cbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCByYXdCeXRlID0gcmF3RGF0YVsxICsgeF07XG4gICAgbGV0IGYyVXAgPSBsYXN0TGluZSA/IGxhc3RMaW5lW3hdIDogMDtcbiAgICB1bmZpbHRlcmVkTGluZVt4XSA9IHJhd0J5dGUgKyBmMlVwO1xuICB9XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl91bkZpbHRlclR5cGUzID0gZnVuY3Rpb24gKFxuICByYXdEYXRhLFxuICB1bmZpbHRlcmVkTGluZSxcbiAgYnl0ZVdpZHRoXG4pIHtcbiAgbGV0IHhDb21wYXJpc29uID0gdGhpcy5feENvbXBhcmlzb247XG4gIGxldCB4QmlnZ2VyVGhhbiA9IHhDb21wYXJpc29uIC0gMTtcbiAgbGV0IGxhc3RMaW5lID0gdGhpcy5fbGFzdExpbmU7XG5cbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCByYXdCeXRlID0gcmF3RGF0YVsxICsgeF07XG4gICAgbGV0IGYzVXAgPSBsYXN0TGluZSA/IGxhc3RMaW5lW3hdIDogMDtcbiAgICBsZXQgZjNMZWZ0ID0geCA+IHhCaWdnZXJUaGFuID8gdW5maWx0ZXJlZExpbmVbeCAtIHhDb21wYXJpc29uXSA6IDA7XG4gICAgbGV0IGYzQWRkID0gTWF0aC5mbG9vcigoZjNMZWZ0ICsgZjNVcCkgLyAyKTtcbiAgICB1bmZpbHRlcmVkTGluZVt4XSA9IHJhd0J5dGUgKyBmM0FkZDtcbiAgfVxufTtcblxuRmlsdGVyLnByb3RvdHlwZS5fdW5GaWx0ZXJUeXBlNCA9IGZ1bmN0aW9uIChcbiAgcmF3RGF0YSxcbiAgdW5maWx0ZXJlZExpbmUsXG4gIGJ5dGVXaWR0aFxuKSB7XG4gIGxldCB4Q29tcGFyaXNvbiA9IHRoaXMuX3hDb21wYXJpc29uO1xuICBsZXQgeEJpZ2dlclRoYW4gPSB4Q29tcGFyaXNvbiAtIDE7XG4gIGxldCBsYXN0TGluZSA9IHRoaXMuX2xhc3RMaW5lO1xuXG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgcmF3Qnl0ZSA9IHJhd0RhdGFbMSArIHhdO1xuICAgIGxldCBmNFVwID0gbGFzdExpbmUgPyBsYXN0TGluZVt4XSA6IDA7XG4gICAgbGV0IGY0TGVmdCA9IHggPiB4QmlnZ2VyVGhhbiA/IHVuZmlsdGVyZWRMaW5lW3ggLSB4Q29tcGFyaXNvbl0gOiAwO1xuICAgIGxldCBmNFVwTGVmdCA9IHggPiB4QmlnZ2VyVGhhbiAmJiBsYXN0TGluZSA/IGxhc3RMaW5lW3ggLSB4Q29tcGFyaXNvbl0gOiAwO1xuICAgIGxldCBmNEFkZCA9IHBhZXRoUHJlZGljdG9yKGY0TGVmdCwgZjRVcCwgZjRVcExlZnQpO1xuICAgIHVuZmlsdGVyZWRMaW5lW3hdID0gcmF3Qnl0ZSArIGY0QWRkO1xuICB9XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl9yZXZlcnNlRmlsdGVyTGluZSA9IGZ1bmN0aW9uIChyYXdEYXRhKSB7XG4gIGxldCBmaWx0ZXIgPSByYXdEYXRhWzBdO1xuICBsZXQgdW5maWx0ZXJlZExpbmU7XG4gIGxldCBjdXJyZW50SW1hZ2UgPSB0aGlzLl9pbWFnZXNbdGhpcy5faW1hZ2VJbmRleF07XG4gIGxldCBieXRlV2lkdGggPSBjdXJyZW50SW1hZ2UuYnl0ZVdpZHRoO1xuXG4gIGlmIChmaWx0ZXIgPT09IDApIHtcbiAgICB1bmZpbHRlcmVkTGluZSA9IHJhd0RhdGEuc2xpY2UoMSwgYnl0ZVdpZHRoICsgMSk7XG4gIH0gZWxzZSB7XG4gICAgdW5maWx0ZXJlZExpbmUgPSBCdWZmZXIuYWxsb2MoYnl0ZVdpZHRoKTtcblxuICAgIHN3aXRjaCAoZmlsdGVyKSB7XG4gICAgICBjYXNlIDE6XG4gICAgICAgIHRoaXMuX3VuRmlsdGVyVHlwZTEocmF3RGF0YSwgdW5maWx0ZXJlZExpbmUsIGJ5dGVXaWR0aCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAyOlxuICAgICAgICB0aGlzLl91bkZpbHRlclR5cGUyKHJhd0RhdGEsIHVuZmlsdGVyZWRMaW5lLCBieXRlV2lkdGgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMzpcbiAgICAgICAgdGhpcy5fdW5GaWx0ZXJUeXBlMyhyYXdEYXRhLCB1bmZpbHRlcmVkTGluZSwgYnl0ZVdpZHRoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDQ6XG4gICAgICAgIHRoaXMuX3VuRmlsdGVyVHlwZTQocmF3RGF0YSwgdW5maWx0ZXJlZExpbmUsIGJ5dGVXaWR0aCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVW5yZWNvZ25pc2VkIGZpbHRlciB0eXBlIC0gXCIgKyBmaWx0ZXIpO1xuICAgIH1cbiAgfVxuXG4gIHRoaXMud3JpdGUodW5maWx0ZXJlZExpbmUpO1xuXG4gIGN1cnJlbnRJbWFnZS5saW5lSW5kZXgrKztcbiAgaWYgKGN1cnJlbnRJbWFnZS5saW5lSW5kZXggPj0gY3VycmVudEltYWdlLmhlaWdodCkge1xuICAgIHRoaXMuX2xhc3RMaW5lID0gbnVsbDtcbiAgICB0aGlzLl9pbWFnZUluZGV4Kys7XG4gICAgY3VycmVudEltYWdlID0gdGhpcy5faW1hZ2VzW3RoaXMuX2ltYWdlSW5kZXhdO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX2xhc3RMaW5lID0gdW5maWx0ZXJlZExpbmU7XG4gIH1cblxuICBpZiAoY3VycmVudEltYWdlKSB7XG4gICAgLy8gcmVhZCwgdXNpbmcgdGhlIGJ5dGUgd2lkdGggdGhhdCBtYXkgYmUgZnJvbSB0aGUgbmV3IGN1cnJlbnQgaW1hZ2VcbiAgICB0aGlzLnJlYWQoY3VycmVudEltYWdlLmJ5dGVXaWR0aCArIDEsIHRoaXMuX3JldmVyc2VGaWx0ZXJMaW5lLmJpbmQodGhpcykpO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX2xhc3RMaW5lID0gbnVsbDtcbiAgICB0aGlzLmNvbXBsZXRlKCk7XG4gIH1cbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5sZXQgQ2h1bmtTdHJlYW0gPSByZXF1aXJlKFwiLi9jaHVua3N0cmVhbVwiKTtcbmxldCBGaWx0ZXIgPSByZXF1aXJlKFwiLi9maWx0ZXItcGFyc2VcIik7XG5cbmxldCBGaWx0ZXJBc3luYyA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChiaXRtYXBJbmZvKSB7XG4gIENodW5rU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgbGV0IGJ1ZmZlcnMgPSBbXTtcbiAgbGV0IHRoYXQgPSB0aGlzO1xuICB0aGlzLl9maWx0ZXIgPSBuZXcgRmlsdGVyKGJpdG1hcEluZm8sIHtcbiAgICByZWFkOiB0aGlzLnJlYWQuYmluZCh0aGlzKSxcbiAgICB3cml0ZTogZnVuY3Rpb24gKGJ1ZmZlcikge1xuICAgICAgYnVmZmVycy5wdXNoKGJ1ZmZlcik7XG4gICAgfSxcbiAgICBjb21wbGV0ZTogZnVuY3Rpb24gKCkge1xuICAgICAgdGhhdC5lbWl0KFwiY29tcGxldGVcIiwgQnVmZmVyLmNvbmNhdChidWZmZXJzKSk7XG4gICAgfSxcbiAgfSk7XG5cbiAgdGhpcy5fZmlsdGVyLnN0YXJ0KCk7XG59KTtcbnV0aWwuaW5oZXJpdHMoRmlsdGVyQXN5bmMsIENodW5rU3RyZWFtKTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIFBOR19TSUdOQVRVUkU6IFsweDg5LCAweDUwLCAweDRlLCAweDQ3LCAweDBkLCAweDBhLCAweDFhLCAweDBhXSxcblxuICBUWVBFX0lIRFI6IDB4NDk0ODQ0NTIsXG4gIFRZUEVfSUVORDogMHg0OTQ1NGU0NCxcbiAgVFlQRV9JREFUOiAweDQ5NDQ0MTU0LFxuICBUWVBFX1BMVEU6IDB4NTA0YzU0NDUsXG4gIFRZUEVfdFJOUzogMHg3NDUyNGU1MywgLy8gZXNsaW50LWRpc2FibGUtbGluZSBjYW1lbGNhc2VcbiAgVFlQRV9nQU1BOiAweDY3NDE0ZDQxLCAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIGNhbWVsY2FzZVxuXG4gIC8vIGNvbG9yLXR5cGUgYml0c1xuICBDT0xPUlRZUEVfR1JBWVNDQUxFOiAwLFxuICBDT0xPUlRZUEVfUEFMRVRURTogMSxcbiAgQ09MT1JUWVBFX0NPTE9SOiAyLFxuICBDT0xPUlRZUEVfQUxQSEE6IDQsIC8vIGUuZy4gZ3JheXNjYWxlIGFuZCBhbHBoYVxuXG4gIC8vIGNvbG9yLXR5cGUgY29tYmluYXRpb25zXG4gIENPTE9SVFlQRV9QQUxFVFRFX0NPTE9SOiAzLFxuICBDT0xPUlRZUEVfQ09MT1JfQUxQSEE6IDYsXG5cbiAgQ09MT1JUWVBFX1RPX0JQUF9NQVA6IHtcbiAgICAwOiAxLFxuICAgIDI6IDMsXG4gICAgMzogMSxcbiAgICA0OiAyLFxuICAgIDY6IDQsXG4gIH0sXG5cbiAgR0FNTUFfRElWSVNJT046IDEwMDAwMCxcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBjcmNUYWJsZSA9IFtdO1xuXG4oZnVuY3Rpb24gKCkge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IDI1NjsgaSsrKSB7XG4gICAgbGV0IGN1cnJlbnRDcmMgPSBpO1xuICAgIGZvciAobGV0IGogPSAwOyBqIDwgODsgaisrKSB7XG4gICAgICBpZiAoY3VycmVudENyYyAmIDEpIHtcbiAgICAgICAgY3VycmVudENyYyA9IDB4ZWRiODgzMjAgXiAoY3VycmVudENyYyA+Pj4gMSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdXJyZW50Q3JjID0gY3VycmVudENyYyA+Pj4gMTtcbiAgICAgIH1cbiAgICB9XG4gICAgY3JjVGFibGVbaV0gPSBjdXJyZW50Q3JjO1xuICB9XG59KSgpO1xuXG5sZXQgQ3JjQ2FsY3VsYXRvciA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5fY3JjID0gLTE7XG59KTtcblxuQ3JjQ2FsY3VsYXRvci5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbiAoZGF0YSkge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGEubGVuZ3RoOyBpKyspIHtcbiAgICB0aGlzLl9jcmMgPSBjcmNUYWJsZVsodGhpcy5fY3JjIF4gZGF0YVtpXSkgJiAweGZmXSBeICh0aGlzLl9jcmMgPj4+IDgpO1xuICB9XG4gIHJldHVybiB0cnVlO1xufTtcblxuQ3JjQ2FsY3VsYXRvci5wcm90b3R5cGUuY3JjMzIgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLl9jcmMgXiAtMTtcbn07XG5cbkNyY0NhbGN1bGF0b3IuY3JjMzIgPSBmdW5jdGlvbiAoYnVmKSB7XG4gIGxldCBjcmMgPSAtMTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBidWYubGVuZ3RoOyBpKyspIHtcbiAgICBjcmMgPSBjcmNUYWJsZVsoY3JjIF4gYnVmW2ldKSAmIDB4ZmZdIF4gKGNyYyA+Pj4gOCk7XG4gIH1cbiAgcmV0dXJuIGNyYyBeIC0xO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuL2NvbnN0YW50c1wiKTtcbmxldCBDcmNDYWxjdWxhdG9yID0gcmVxdWlyZShcIi4vY3JjXCIpO1xuXG5sZXQgUGFyc2VyID0gKG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKG9wdGlvbnMsIGRlcGVuZGVuY2llcykge1xuICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgb3B0aW9ucy5jaGVja0NSQyA9IG9wdGlvbnMuY2hlY2tDUkMgIT09IGZhbHNlO1xuXG4gIHRoaXMuX2hhc0lIRFIgPSBmYWxzZTtcbiAgdGhpcy5faGFzSUVORCA9IGZhbHNlO1xuICB0aGlzLl9lbWl0dGVkSGVhZGVyc0ZpbmlzaGVkID0gZmFsc2U7XG5cbiAgLy8gaW5wdXQgZmxhZ3MvbWV0YWRhdGFcbiAgdGhpcy5fcGFsZXR0ZSA9IFtdO1xuICB0aGlzLl9jb2xvclR5cGUgPSAwO1xuXG4gIHRoaXMuX2NodW5rcyA9IHt9O1xuICB0aGlzLl9jaHVua3NbY29uc3RhbnRzLlRZUEVfSUhEUl0gPSB0aGlzLl9oYW5kbGVJSERSLmJpbmQodGhpcyk7XG4gIHRoaXMuX2NodW5rc1tjb25zdGFudHMuVFlQRV9JRU5EXSA9IHRoaXMuX2hhbmRsZUlFTkQuYmluZCh0aGlzKTtcbiAgdGhpcy5fY2h1bmtzW2NvbnN0YW50cy5UWVBFX0lEQVRdID0gdGhpcy5faGFuZGxlSURBVC5iaW5kKHRoaXMpO1xuICB0aGlzLl9jaHVua3NbY29uc3RhbnRzLlRZUEVfUExURV0gPSB0aGlzLl9oYW5kbGVQTFRFLmJpbmQodGhpcyk7XG4gIHRoaXMuX2NodW5rc1tjb25zdGFudHMuVFlQRV90Uk5TXSA9IHRoaXMuX2hhbmRsZVRSTlMuYmluZCh0aGlzKTtcbiAgdGhpcy5fY2h1bmtzW2NvbnN0YW50cy5UWVBFX2dBTUFdID0gdGhpcy5faGFuZGxlR0FNQS5iaW5kKHRoaXMpO1xuXG4gIHRoaXMucmVhZCA9IGRlcGVuZGVuY2llcy5yZWFkO1xuICB0aGlzLmVycm9yID0gZGVwZW5kZW5jaWVzLmVycm9yO1xuICB0aGlzLm1ldGFkYXRhID0gZGVwZW5kZW5jaWVzLm1ldGFkYXRhO1xuICB0aGlzLmdhbW1hID0gZGVwZW5kZW5jaWVzLmdhbW1hO1xuICB0aGlzLnRyYW5zQ29sb3IgPSBkZXBlbmRlbmNpZXMudHJhbnNDb2xvcjtcbiAgdGhpcy5wYWxldHRlID0gZGVwZW5kZW5jaWVzLnBhbGV0dGU7XG4gIHRoaXMucGFyc2VkID0gZGVwZW5kZW5jaWVzLnBhcnNlZDtcbiAgdGhpcy5pbmZsYXRlRGF0YSA9IGRlcGVuZGVuY2llcy5pbmZsYXRlRGF0YTtcbiAgdGhpcy5maW5pc2hlZCA9IGRlcGVuZGVuY2llcy5maW5pc2hlZDtcbiAgdGhpcy5zaW1wbGVUcmFuc3BhcmVuY3kgPSBkZXBlbmRlbmNpZXMuc2ltcGxlVHJhbnNwYXJlbmN5O1xuICB0aGlzLmhlYWRlcnNGaW5pc2hlZCA9IGRlcGVuZGVuY2llcy5oZWFkZXJzRmluaXNoZWQgfHwgZnVuY3Rpb24gKCkge307XG59KTtcblxuUGFyc2VyLnByb3RvdHlwZS5zdGFydCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5yZWFkKGNvbnN0YW50cy5QTkdfU0lHTkFUVVJFLmxlbmd0aCwgdGhpcy5fcGFyc2VTaWduYXR1cmUuYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZVNpZ25hdHVyZSA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIGxldCBzaWduYXR1cmUgPSBjb25zdGFudHMuUE5HX1NJR05BVFVSRTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IHNpZ25hdHVyZS5sZW5ndGg7IGkrKykge1xuICAgIGlmIChkYXRhW2ldICE9PSBzaWduYXR1cmVbaV0pIHtcbiAgICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiSW52YWxpZCBmaWxlIHNpZ25hdHVyZVwiKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG4gIHRoaXMucmVhZCg4LCB0aGlzLl9wYXJzZUNodW5rQmVnaW4uYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUNodW5rQmVnaW4gPSBmdW5jdGlvbiAoZGF0YSkge1xuICAvLyBjaHVuayBjb250ZW50IGxlbmd0aFxuICBsZXQgbGVuZ3RoID0gZGF0YS5yZWFkVUludDMyQkUoMCk7XG5cbiAgLy8gY2h1bmsgdHlwZVxuICBsZXQgdHlwZSA9IGRhdGEucmVhZFVJbnQzMkJFKDQpO1xuICBsZXQgbmFtZSA9IFwiXCI7XG4gIGZvciAobGV0IGkgPSA0OyBpIDwgODsgaSsrKSB7XG4gICAgbmFtZSArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGRhdGFbaV0pO1xuICB9XG5cbiAgLy9jb25zb2xlLmxvZygnY2h1bmsgJywgbmFtZSwgbGVuZ3RoKTtcblxuICAvLyBjaHVuayBmbGFnc1xuICBsZXQgYW5jaWxsYXJ5ID0gQm9vbGVhbihkYXRhWzRdICYgMHgyMCk7IC8vIG9yIGNyaXRpY2FsXG4gIC8vICAgIHByaXYgPSBCb29sZWFuKGRhdGFbNV0gJiAweDIwKSwgLy8gb3IgcHVibGljXG4gIC8vICAgIHNhZmVUb0NvcHkgPSBCb29sZWFuKGRhdGFbN10gJiAweDIwKTsgLy8gb3IgdW5zYWZlXG5cbiAgaWYgKCF0aGlzLl9oYXNJSERSICYmIHR5cGUgIT09IGNvbnN0YW50cy5UWVBFX0lIRFIpIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIkV4cGVjdGVkIElIRFIgb24gYmVnZ2luaW5nXCIpKTtcbiAgICByZXR1cm47XG4gIH1cblxuICB0aGlzLl9jcmMgPSBuZXcgQ3JjQ2FsY3VsYXRvcigpO1xuICB0aGlzLl9jcmMud3JpdGUoQnVmZmVyLmZyb20obmFtZSkpO1xuXG4gIGlmICh0aGlzLl9jaHVua3NbdHlwZV0pIHtcbiAgICByZXR1cm4gdGhpcy5fY2h1bmtzW3R5cGVdKGxlbmd0aCk7XG4gIH1cblxuICBpZiAoIWFuY2lsbGFyeSkge1xuICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgY3JpdGljYWwgY2h1bmsgdHlwZSBcIiArIG5hbWUpKTtcbiAgICByZXR1cm47XG4gIH1cblxuICB0aGlzLnJlYWQobGVuZ3RoICsgNCwgdGhpcy5fc2tpcENodW5rLmJpbmQodGhpcykpO1xufTtcblxuUGFyc2VyLnByb3RvdHlwZS5fc2tpcENodW5rID0gZnVuY3Rpb24gKC8qZGF0YSovKSB7XG4gIHRoaXMucmVhZCg4LCB0aGlzLl9wYXJzZUNodW5rQmVnaW4uYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9oYW5kbGVDaHVua0VuZCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5yZWFkKDQsIHRoaXMuX3BhcnNlQ2h1bmtFbmQuYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUNodW5rRW5kID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgbGV0IGZpbGVDcmMgPSBkYXRhLnJlYWRJbnQzMkJFKDApO1xuICBsZXQgY2FsY0NyYyA9IHRoaXMuX2NyYy5jcmMzMigpO1xuXG4gIC8vIGNoZWNrIENSQ1xuICBpZiAodGhpcy5fb3B0aW9ucy5jaGVja0NSQyAmJiBjYWxjQ3JjICE9PSBmaWxlQ3JjKSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJDcmMgZXJyb3IgLSBcIiArIGZpbGVDcmMgKyBcIiAtIFwiICsgY2FsY0NyYykpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5faGFzSUVORCkge1xuICAgIHRoaXMucmVhZCg4LCB0aGlzLl9wYXJzZUNodW5rQmVnaW4uYmluZCh0aGlzKSk7XG4gIH1cbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUlIRFIgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlSUhEUi5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUlIRFIgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG5cbiAgbGV0IHdpZHRoID0gZGF0YS5yZWFkVUludDMyQkUoMCk7XG4gIGxldCBoZWlnaHQgPSBkYXRhLnJlYWRVSW50MzJCRSg0KTtcbiAgbGV0IGRlcHRoID0gZGF0YVs4XTtcbiAgbGV0IGNvbG9yVHlwZSA9IGRhdGFbOV07IC8vIGJpdHM6IDEgcGFsZXR0ZSwgMiBjb2xvciwgNCBhbHBoYVxuICBsZXQgY29tcHIgPSBkYXRhWzEwXTtcbiAgbGV0IGZpbHRlciA9IGRhdGFbMTFdO1xuICBsZXQgaW50ZXJsYWNlID0gZGF0YVsxMl07XG5cbiAgLy8gY29uc29sZS5sb2coJyAgICB3aWR0aCcsIHdpZHRoLCAnaGVpZ2h0JywgaGVpZ2h0LFxuICAvLyAgICAgJ2RlcHRoJywgZGVwdGgsICdjb2xvclR5cGUnLCBjb2xvclR5cGUsXG4gIC8vICAgICAnY29tcHInLCBjb21wciwgJ2ZpbHRlcicsIGZpbHRlciwgJ2ludGVybGFjZScsIGludGVybGFjZVxuICAvLyApO1xuXG4gIGlmIChcbiAgICBkZXB0aCAhPT0gOCAmJlxuICAgIGRlcHRoICE9PSA0ICYmXG4gICAgZGVwdGggIT09IDIgJiZcbiAgICBkZXB0aCAhPT0gMSAmJlxuICAgIGRlcHRoICE9PSAxNlxuICApIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGJpdCBkZXB0aCBcIiArIGRlcHRoKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghKGNvbG9yVHlwZSBpbiBjb25zdGFudHMuQ09MT1JUWVBFX1RPX0JQUF9NQVApKSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBjb2xvciB0eXBlXCIpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGNvbXByICE9PSAwKSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBjb21wcmVzc2lvbiBtZXRob2RcIikpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoZmlsdGVyICE9PSAwKSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBmaWx0ZXIgbWV0aG9kXCIpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGludGVybGFjZSAhPT0gMCAmJiBpbnRlcmxhY2UgIT09IDEpIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGludGVybGFjZSBtZXRob2RcIikpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMuX2NvbG9yVHlwZSA9IGNvbG9yVHlwZTtcblxuICBsZXQgYnBwID0gY29uc3RhbnRzLkNPTE9SVFlQRV9UT19CUFBfTUFQW3RoaXMuX2NvbG9yVHlwZV07XG5cbiAgdGhpcy5faGFzSUhEUiA9IHRydWU7XG5cbiAgdGhpcy5tZXRhZGF0YSh7XG4gICAgd2lkdGg6IHdpZHRoLFxuICAgIGhlaWdodDogaGVpZ2h0LFxuICAgIGRlcHRoOiBkZXB0aCxcbiAgICBpbnRlcmxhY2U6IEJvb2xlYW4oaW50ZXJsYWNlKSxcbiAgICBwYWxldHRlOiBCb29sZWFuKGNvbG9yVHlwZSAmIGNvbnN0YW50cy5DT0xPUlRZUEVfUEFMRVRURSksXG4gICAgY29sb3I6IEJvb2xlYW4oY29sb3JUeXBlICYgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUiksXG4gICAgYWxwaGE6IEJvb2xlYW4oY29sb3JUeXBlICYgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQSksXG4gICAgYnBwOiBicHAsXG4gICAgY29sb3JUeXBlOiBjb2xvclR5cGUsXG4gIH0pO1xuXG4gIHRoaXMuX2hhbmRsZUNodW5rRW5kKCk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9oYW5kbGVQTFRFID0gZnVuY3Rpb24gKGxlbmd0aCkge1xuICB0aGlzLnJlYWQobGVuZ3RoLCB0aGlzLl9wYXJzZVBMVEUuYmluZCh0aGlzKSk7XG59O1xuUGFyc2VyLnByb3RvdHlwZS5fcGFyc2VQTFRFID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgdGhpcy5fY3JjLndyaXRlKGRhdGEpO1xuXG4gIGxldCBlbnRyaWVzID0gTWF0aC5mbG9vcihkYXRhLmxlbmd0aCAvIDMpO1xuICAvLyBjb25zb2xlLmxvZygnUGFsZXR0ZTonLCBlbnRyaWVzKTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGVudHJpZXM7IGkrKykge1xuICAgIHRoaXMuX3BhbGV0dGUucHVzaChbZGF0YVtpICogM10sIGRhdGFbaSAqIDMgKyAxXSwgZGF0YVtpICogMyArIDJdLCAweGZmXSk7XG4gIH1cblxuICB0aGlzLnBhbGV0dGUodGhpcy5fcGFsZXR0ZSk7XG5cbiAgdGhpcy5faGFuZGxlQ2h1bmtFbmQoKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZVRSTlMgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMuc2ltcGxlVHJhbnNwYXJlbmN5KCk7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlVFJOUy5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZVRSTlMgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG5cbiAgLy8gcGFsZXR0ZVxuICBpZiAodGhpcy5fY29sb3JUeXBlID09PSBjb25zdGFudHMuQ09MT1JUWVBFX1BBTEVUVEVfQ09MT1IpIHtcbiAgICBpZiAodGhpcy5fcGFsZXR0ZS5sZW5ndGggPT09IDApIHtcbiAgICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiVHJhbnNwYXJlbmN5IGNodW5rIG11c3QgYmUgYWZ0ZXIgcGFsZXR0ZVwiKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChkYXRhLmxlbmd0aCA+IHRoaXMuX3BhbGV0dGUubGVuZ3RoKSB7XG4gICAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIk1vcmUgdHJhbnNwYXJlbnQgY29sb3JzIHRoYW4gcGFsZXR0ZSBzaXplXCIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBkYXRhLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLl9wYWxldHRlW2ldWzNdID0gZGF0YVtpXTtcbiAgICB9XG4gICAgdGhpcy5wYWxldHRlKHRoaXMuX3BhbGV0dGUpO1xuICB9XG5cbiAgLy8gZm9yIGNvbG9yVHlwZSAwIChncmF5c2NhbGUpIGFuZCAyIChyZ2IpXG4gIC8vIHRoZXJlIG1pZ2h0IGJlIG9uZSBncmF5L2NvbG9yIGRlZmluZWQgYXMgdHJhbnNwYXJlbnRcbiAgaWYgKHRoaXMuX2NvbG9yVHlwZSA9PT0gY29uc3RhbnRzLkNPTE9SVFlQRV9HUkFZU0NBTEUpIHtcbiAgICAvLyBncmV5LCAyIGJ5dGVzXG4gICAgdGhpcy50cmFuc0NvbG9yKFtkYXRhLnJlYWRVSW50MTZCRSgwKV0pO1xuICB9XG4gIGlmICh0aGlzLl9jb2xvclR5cGUgPT09IGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1IpIHtcbiAgICB0aGlzLnRyYW5zQ29sb3IoW1xuICAgICAgZGF0YS5yZWFkVUludDE2QkUoMCksXG4gICAgICBkYXRhLnJlYWRVSW50MTZCRSgyKSxcbiAgICAgIGRhdGEucmVhZFVJbnQxNkJFKDQpLFxuICAgIF0pO1xuICB9XG5cbiAgdGhpcy5faGFuZGxlQ2h1bmtFbmQoKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUdBTUEgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlR0FNQS5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUdBTUEgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG4gIHRoaXMuZ2FtbWEoZGF0YS5yZWFkVUludDMyQkUoMCkgLyBjb25zdGFudHMuR0FNTUFfRElWSVNJT04pO1xuXG4gIHRoaXMuX2hhbmRsZUNodW5rRW5kKCk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9oYW5kbGVJREFUID0gZnVuY3Rpb24gKGxlbmd0aCkge1xuICBpZiAoIXRoaXMuX2VtaXR0ZWRIZWFkZXJzRmluaXNoZWQpIHtcbiAgICB0aGlzLl9lbWl0dGVkSGVhZGVyc0ZpbmlzaGVkID0gdHJ1ZTtcbiAgICB0aGlzLmhlYWRlcnNGaW5pc2hlZCgpO1xuICB9XG4gIHRoaXMucmVhZCgtbGVuZ3RoLCB0aGlzLl9wYXJzZUlEQVQuYmluZCh0aGlzLCBsZW5ndGgpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUlEQVQgPSBmdW5jdGlvbiAobGVuZ3RoLCBkYXRhKSB7XG4gIHRoaXMuX2NyYy53cml0ZShkYXRhKTtcblxuICBpZiAoXG4gICAgdGhpcy5fY29sb3JUeXBlID09PSBjb25zdGFudHMuQ09MT1JUWVBFX1BBTEVUVEVfQ09MT1IgJiZcbiAgICB0aGlzLl9wYWxldHRlLmxlbmd0aCA9PT0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJFeHBlY3RlZCBwYWxldHRlIG5vdCBmb3VuZFwiKTtcbiAgfVxuXG4gIHRoaXMuaW5mbGF0ZURhdGEoZGF0YSk7XG4gIGxldCBsZWZ0T3Zlckxlbmd0aCA9IGxlbmd0aCAtIGRhdGEubGVuZ3RoO1xuXG4gIGlmIChsZWZ0T3Zlckxlbmd0aCA+IDApIHtcbiAgICB0aGlzLl9oYW5kbGVJREFUKGxlZnRPdmVyTGVuZ3RoKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLl9oYW5kbGVDaHVua0VuZCgpO1xuICB9XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9oYW5kbGVJRU5EID0gZnVuY3Rpb24gKGxlbmd0aCkge1xuICB0aGlzLnJlYWQobGVuZ3RoLCB0aGlzLl9wYXJzZUlFTkQuYmluZCh0aGlzKSk7XG59O1xuUGFyc2VyLnByb3RvdHlwZS5fcGFyc2VJRU5EID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgdGhpcy5fY3JjLndyaXRlKGRhdGEpO1xuXG4gIHRoaXMuX2hhc0lFTkQgPSB0cnVlO1xuICB0aGlzLl9oYW5kbGVDaHVua0VuZCgpO1xuXG4gIGlmICh0aGlzLmZpbmlzaGVkKSB7XG4gICAgdGhpcy5maW5pc2hlZCgpO1xuICB9XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgaW50ZXJsYWNlVXRpbHMgPSByZXF1aXJlKFwiLi9pbnRlcmxhY2VcIik7XG5cbmxldCBwaXhlbEJwcE1hcHBlciA9IFtcbiAgLy8gMCAtIGR1bW15IGVudHJ5XG4gIGZ1bmN0aW9uICgpIHt9LFxuXG4gIC8vIDEgLSBMXG4gIC8vIDA6IDAsIDE6IDAsIDI6IDAsIDM6IDB4ZmZcbiAgZnVuY3Rpb24gKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcykge1xuICAgIGlmIChyYXdQb3MgPT09IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuXG4gICAgbGV0IHBpeGVsID0gZGF0YVtyYXdQb3NdO1xuICAgIHB4RGF0YVtweFBvc10gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSAweGZmO1xuICB9LFxuXG4gIC8vIDIgLSBMQVxuICAvLyAwOiAwLCAxOiAwLCAyOiAwLCAzOiAxXG4gIGZ1bmN0aW9uIChweERhdGEsIGRhdGEsIHB4UG9zLCByYXdQb3MpIHtcbiAgICBpZiAocmF3UG9zICsgMSA+PSBkYXRhLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiUmFuIG91dCBvZiBkYXRhXCIpO1xuICAgIH1cblxuICAgIGxldCBwaXhlbCA9IGRhdGFbcmF3UG9zXTtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gZGF0YVtyYXdQb3MgKyAxXTtcbiAgfSxcblxuICAvLyAzIC0gUkdCXG4gIC8vIDA6IDAsIDE6IDEsIDI6IDIsIDM6IDB4ZmZcbiAgZnVuY3Rpb24gKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcykge1xuICAgIGlmIChyYXdQb3MgKyAyID49IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuXG4gICAgcHhEYXRhW3B4UG9zXSA9IGRhdGFbcmF3UG9zXTtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IGRhdGFbcmF3UG9zICsgMV07XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBkYXRhW3Jhd1BvcyArIDJdO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gMHhmZjtcbiAgfSxcblxuICAvLyA0IC0gUkdCQVxuICAvLyAwOiAwLCAxOiAxLCAyOiAyLCAzOiAzXG4gIGZ1bmN0aW9uIChweERhdGEsIGRhdGEsIHB4UG9zLCByYXdQb3MpIHtcbiAgICBpZiAocmF3UG9zICsgMyA+PSBkYXRhLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiUmFuIG91dCBvZiBkYXRhXCIpO1xuICAgIH1cblxuICAgIHB4RGF0YVtweFBvc10gPSBkYXRhW3Jhd1Bvc107XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBkYXRhW3Jhd1BvcyArIDFdO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gZGF0YVtyYXdQb3MgKyAyXTtcbiAgICBweERhdGFbcHhQb3MgKyAzXSA9IGRhdGFbcmF3UG9zICsgM107XG4gIH0sXG5dO1xuXG5sZXQgcGl4ZWxCcHBDdXN0b21NYXBwZXIgPSBbXG4gIC8vIDAgLSBkdW1teSBlbnRyeVxuICBmdW5jdGlvbiAoKSB7fSxcblxuICAvLyAxIC0gTFxuICAvLyAwOiAwLCAxOiAwLCAyOiAwLCAzOiAweGZmXG4gIGZ1bmN0aW9uIChweERhdGEsIHBpeGVsRGF0YSwgcHhQb3MsIG1heEJpdCkge1xuICAgIGxldCBwaXhlbCA9IHBpeGVsRGF0YVswXTtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gbWF4Qml0O1xuICB9LFxuXG4gIC8vIDIgLSBMQVxuICAvLyAwOiAwLCAxOiAwLCAyOiAwLCAzOiAxXG4gIGZ1bmN0aW9uIChweERhdGEsIHBpeGVsRGF0YSwgcHhQb3MpIHtcbiAgICBsZXQgcGl4ZWwgPSBwaXhlbERhdGFbMF07XG4gICAgcHhEYXRhW3B4UG9zXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAzXSA9IHBpeGVsRGF0YVsxXTtcbiAgfSxcblxuICAvLyAzIC0gUkdCXG4gIC8vIDA6IDAsIDE6IDEsIDI6IDIsIDM6IDB4ZmZcbiAgZnVuY3Rpb24gKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcywgbWF4Qml0KSB7XG4gICAgcHhEYXRhW3B4UG9zXSA9IHBpeGVsRGF0YVswXTtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IHBpeGVsRGF0YVsxXTtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IHBpeGVsRGF0YVsyXTtcbiAgICBweERhdGFbcHhQb3MgKyAzXSA9IG1heEJpdDtcbiAgfSxcblxuICAvLyA0IC0gUkdCQVxuICAvLyAwOiAwLCAxOiAxLCAyOiAyLCAzOiAzXG4gIGZ1bmN0aW9uIChweERhdGEsIHBpeGVsRGF0YSwgcHhQb3MpIHtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWxEYXRhWzBdO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gcGl4ZWxEYXRhWzFdO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWxEYXRhWzJdO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gcGl4ZWxEYXRhWzNdO1xuICB9LFxuXTtcblxuZnVuY3Rpb24gYml0UmV0cmlldmVyKGRhdGEsIGRlcHRoKSB7XG4gIGxldCBsZWZ0T3ZlciA9IFtdO1xuICBsZXQgaSA9IDA7XG5cbiAgZnVuY3Rpb24gc3BsaXQoKSB7XG4gICAgaWYgKGkgPT09IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuICAgIGxldCBieXRlID0gZGF0YVtpXTtcbiAgICBpKys7XG4gICAgbGV0IGJ5dGU4LCBieXRlNywgYnl0ZTYsIGJ5dGU1LCBieXRlNCwgYnl0ZTMsIGJ5dGUyLCBieXRlMTtcbiAgICBzd2l0Y2ggKGRlcHRoKSB7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bnJlY29nbmlzZWQgZGVwdGhcIik7XG4gICAgICBjYXNlIDE2OlxuICAgICAgICBieXRlMiA9IGRhdGFbaV07XG4gICAgICAgIGkrKztcbiAgICAgICAgbGVmdE92ZXIucHVzaCgoYnl0ZSA8PCA4KSArIGJ5dGUyKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDQ6XG4gICAgICAgIGJ5dGUyID0gYnl0ZSAmIDB4MGY7XG4gICAgICAgIGJ5dGUxID0gYnl0ZSA+PiA0O1xuICAgICAgICBsZWZ0T3Zlci5wdXNoKGJ5dGUxLCBieXRlMik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAyOlxuICAgICAgICBieXRlNCA9IGJ5dGUgJiAzO1xuICAgICAgICBieXRlMyA9IChieXRlID4+IDIpICYgMztcbiAgICAgICAgYnl0ZTIgPSAoYnl0ZSA+PiA0KSAmIDM7XG4gICAgICAgIGJ5dGUxID0gKGJ5dGUgPj4gNikgJiAzO1xuICAgICAgICBsZWZ0T3Zlci5wdXNoKGJ5dGUxLCBieXRlMiwgYnl0ZTMsIGJ5dGU0KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDE6XG4gICAgICAgIGJ5dGU4ID0gYnl0ZSAmIDE7XG4gICAgICAgIGJ5dGU3ID0gKGJ5dGUgPj4gMSkgJiAxO1xuICAgICAgICBieXRlNiA9IChieXRlID4+IDIpICYgMTtcbiAgICAgICAgYnl0ZTUgPSAoYnl0ZSA+PiAzKSAmIDE7XG4gICAgICAgIGJ5dGU0ID0gKGJ5dGUgPj4gNCkgJiAxO1xuICAgICAgICBieXRlMyA9IChieXRlID4+IDUpICYgMTtcbiAgICAgICAgYnl0ZTIgPSAoYnl0ZSA+PiA2KSAmIDE7XG4gICAgICAgIGJ5dGUxID0gKGJ5dGUgPj4gNykgJiAxO1xuICAgICAgICBsZWZ0T3Zlci5wdXNoKGJ5dGUxLCBieXRlMiwgYnl0ZTMsIGJ5dGU0LCBieXRlNSwgYnl0ZTYsIGJ5dGU3LCBieXRlOCk7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgZ2V0OiBmdW5jdGlvbiAoY291bnQpIHtcbiAgICAgIHdoaWxlIChsZWZ0T3Zlci5sZW5ndGggPCBjb3VudCkge1xuICAgICAgICBzcGxpdCgpO1xuICAgICAgfVxuICAgICAgbGV0IHJldHVybmVyID0gbGVmdE92ZXIuc2xpY2UoMCwgY291bnQpO1xuICAgICAgbGVmdE92ZXIgPSBsZWZ0T3Zlci5zbGljZShjb3VudCk7XG4gICAgICByZXR1cm4gcmV0dXJuZXI7XG4gICAgfSxcbiAgICByZXNldEFmdGVyTGluZTogZnVuY3Rpb24gKCkge1xuICAgICAgbGVmdE92ZXIubGVuZ3RoID0gMDtcbiAgICB9LFxuICAgIGVuZDogZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKGkgIT09IGRhdGEubGVuZ3RoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImV4dHJhIGRhdGEgZm91bmRcIik7XG4gICAgICB9XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFwSW1hZ2U4Qml0KGltYWdlLCBweERhdGEsIGdldFB4UG9zLCBicHAsIGRhdGEsIHJhd1Bvcykge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG1heC1wYXJhbXNcbiAgbGV0IGltYWdlV2lkdGggPSBpbWFnZS53aWR0aDtcbiAgbGV0IGltYWdlSGVpZ2h0ID0gaW1hZ2UuaGVpZ2h0O1xuICBsZXQgaW1hZ2VQYXNzID0gaW1hZ2UuaW5kZXg7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaW1hZ2VIZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgaW1hZ2VXaWR0aDsgeCsrKSB7XG4gICAgICBsZXQgcHhQb3MgPSBnZXRQeFBvcyh4LCB5LCBpbWFnZVBhc3MpO1xuICAgICAgcGl4ZWxCcHBNYXBwZXJbYnBwXShweERhdGEsIGRhdGEsIHB4UG9zLCByYXdQb3MpO1xuICAgICAgcmF3UG9zICs9IGJwcDsgLy9lc2xpbnQtZGlzYWJsZS1saW5lIG5vLXBhcmFtLXJlYXNzaWduXG4gICAgfVxuICB9XG4gIHJldHVybiByYXdQb3M7XG59XG5cbmZ1bmN0aW9uIG1hcEltYWdlQ3VzdG9tQml0KGltYWdlLCBweERhdGEsIGdldFB4UG9zLCBicHAsIGJpdHMsIG1heEJpdCkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG1heC1wYXJhbXNcbiAgbGV0IGltYWdlV2lkdGggPSBpbWFnZS53aWR0aDtcbiAgbGV0IGltYWdlSGVpZ2h0ID0gaW1hZ2UuaGVpZ2h0O1xuICBsZXQgaW1hZ2VQYXNzID0gaW1hZ2UuaW5kZXg7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaW1hZ2VIZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgaW1hZ2VXaWR0aDsgeCsrKSB7XG4gICAgICBsZXQgcGl4ZWxEYXRhID0gYml0cy5nZXQoYnBwKTtcbiAgICAgIGxldCBweFBvcyA9IGdldFB4UG9zKHgsIHksIGltYWdlUGFzcyk7XG4gICAgICBwaXhlbEJwcEN1c3RvbU1hcHBlclticHBdKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcywgbWF4Qml0KTtcbiAgICB9XG4gICAgYml0cy5yZXNldEFmdGVyTGluZSgpO1xuICB9XG59XG5cbmV4cG9ydHMuZGF0YVRvQml0TWFwID0gZnVuY3Rpb24gKGRhdGEsIGJpdG1hcEluZm8pIHtcbiAgbGV0IHdpZHRoID0gYml0bWFwSW5mby53aWR0aDtcbiAgbGV0IGhlaWdodCA9IGJpdG1hcEluZm8uaGVpZ2h0O1xuICBsZXQgZGVwdGggPSBiaXRtYXBJbmZvLmRlcHRoO1xuICBsZXQgYnBwID0gYml0bWFwSW5mby5icHA7XG4gIGxldCBpbnRlcmxhY2UgPSBiaXRtYXBJbmZvLmludGVybGFjZTtcbiAgbGV0IGJpdHM7XG5cbiAgaWYgKGRlcHRoICE9PSA4KSB7XG4gICAgYml0cyA9IGJpdFJldHJpZXZlcihkYXRhLCBkZXB0aCk7XG4gIH1cbiAgbGV0IHB4RGF0YTtcbiAgaWYgKGRlcHRoIDw9IDgpIHtcbiAgICBweERhdGEgPSBCdWZmZXIuYWxsb2Mod2lkdGggKiBoZWlnaHQgKiA0KTtcbiAgfSBlbHNlIHtcbiAgICBweERhdGEgPSBuZXcgVWludDE2QXJyYXkod2lkdGggKiBoZWlnaHQgKiA0KTtcbiAgfVxuICBsZXQgbWF4Qml0ID0gTWF0aC5wb3coMiwgZGVwdGgpIC0gMTtcbiAgbGV0IHJhd1BvcyA9IDA7XG4gIGxldCBpbWFnZXM7XG4gIGxldCBnZXRQeFBvcztcblxuICBpZiAoaW50ZXJsYWNlKSB7XG4gICAgaW1hZ2VzID0gaW50ZXJsYWNlVXRpbHMuZ2V0SW1hZ2VQYXNzZXMod2lkdGgsIGhlaWdodCk7XG4gICAgZ2V0UHhQb3MgPSBpbnRlcmxhY2VVdGlscy5nZXRJbnRlcmxhY2VJdGVyYXRvcih3aWR0aCwgaGVpZ2h0KTtcbiAgfSBlbHNlIHtcbiAgICBsZXQgbm9uSW50ZXJsYWNlZFB4UG9zID0gMDtcbiAgICBnZXRQeFBvcyA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIGxldCByZXR1cm5lciA9IG5vbkludGVybGFjZWRQeFBvcztcbiAgICAgIG5vbkludGVybGFjZWRQeFBvcyArPSA0O1xuICAgICAgcmV0dXJuIHJldHVybmVyO1xuICAgIH07XG4gICAgaW1hZ2VzID0gW3sgd2lkdGg6IHdpZHRoLCBoZWlnaHQ6IGhlaWdodCB9XTtcbiAgfVxuXG4gIGZvciAobGV0IGltYWdlSW5kZXggPSAwOyBpbWFnZUluZGV4IDwgaW1hZ2VzLmxlbmd0aDsgaW1hZ2VJbmRleCsrKSB7XG4gICAgaWYgKGRlcHRoID09PSA4KSB7XG4gICAgICByYXdQb3MgPSBtYXBJbWFnZThCaXQoXG4gICAgICAgIGltYWdlc1tpbWFnZUluZGV4XSxcbiAgICAgICAgcHhEYXRhLFxuICAgICAgICBnZXRQeFBvcyxcbiAgICAgICAgYnBwLFxuICAgICAgICBkYXRhLFxuICAgICAgICByYXdQb3NcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1hcEltYWdlQ3VzdG9tQml0KFxuICAgICAgICBpbWFnZXNbaW1hZ2VJbmRleF0sXG4gICAgICAgIHB4RGF0YSxcbiAgICAgICAgZ2V0UHhQb3MsXG4gICAgICAgIGJwcCxcbiAgICAgICAgYml0cyxcbiAgICAgICAgbWF4Qml0XG4gICAgICApO1xuICAgIH1cbiAgfVxuICBpZiAoZGVwdGggPT09IDgpIHtcbiAgICBpZiAocmF3UG9zICE9PSBkYXRhLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiZXh0cmEgZGF0YSBmb3VuZFwiKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgYml0cy5lbmQoKTtcbiAgfVxuXG4gIHJldHVybiBweERhdGE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5mdW5jdGlvbiBkZVBhbGV0dGUoaW5kYXRhLCBvdXRkYXRhLCB3aWR0aCwgaGVpZ2h0LCBwYWxldHRlKSB7XG4gIGxldCBweFBvcyA9IDA7XG4gIC8vIHVzZSB2YWx1ZXMgZnJvbSBwYWxldHRlXG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHdpZHRoOyB4KyspIHtcbiAgICAgIGxldCBjb2xvciA9IHBhbGV0dGVbaW5kYXRhW3B4UG9zXV07XG5cbiAgICAgIGlmICghY29sb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaW5kZXggXCIgKyBpbmRhdGFbcHhQb3NdICsgXCIgbm90IGluIHBhbGV0dGVcIik7XG4gICAgICB9XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNDsgaSsrKSB7XG4gICAgICAgIG91dGRhdGFbcHhQb3MgKyBpXSA9IGNvbG9yW2ldO1xuICAgICAgfVxuICAgICAgcHhQb3MgKz0gNDtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVwbGFjZVRyYW5zcGFyZW50Q29sb3IoaW5kYXRhLCBvdXRkYXRhLCB3aWR0aCwgaGVpZ2h0LCB0cmFuc0NvbG9yKSB7XG4gIGxldCBweFBvcyA9IDA7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHdpZHRoOyB4KyspIHtcbiAgICAgIGxldCBtYWtlVHJhbnMgPSBmYWxzZTtcblxuICAgICAgaWYgKHRyYW5zQ29sb3IubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIGlmICh0cmFuc0NvbG9yWzBdID09PSBpbmRhdGFbcHhQb3NdKSB7XG4gICAgICAgICAgbWFrZVRyYW5zID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgdHJhbnNDb2xvclswXSA9PT0gaW5kYXRhW3B4UG9zXSAmJlxuICAgICAgICB0cmFuc0NvbG9yWzFdID09PSBpbmRhdGFbcHhQb3MgKyAxXSAmJlxuICAgICAgICB0cmFuc0NvbG9yWzJdID09PSBpbmRhdGFbcHhQb3MgKyAyXVxuICAgICAgKSB7XG4gICAgICAgIG1ha2VUcmFucyA9IHRydWU7XG4gICAgICB9XG4gICAgICBpZiAobWFrZVRyYW5zKSB7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNDsgaSsrKSB7XG4gICAgICAgICAgb3V0ZGF0YVtweFBvcyArIGldID0gMDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcHhQb3MgKz0gNDtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gc2NhbGVEZXB0aChpbmRhdGEsIG91dGRhdGEsIHdpZHRoLCBoZWlnaHQsIGRlcHRoKSB7XG4gIGxldCBtYXhPdXRTYW1wbGUgPSAyNTU7XG4gIGxldCBtYXhJblNhbXBsZSA9IE1hdGgucG93KDIsIGRlcHRoKSAtIDE7XG4gIGxldCBweFBvcyA9IDA7XG5cbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgd2lkdGg7IHgrKykge1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgb3V0ZGF0YVtweFBvcyArIGldID0gTWF0aC5mbG9vcihcbiAgICAgICAgICAoaW5kYXRhW3B4UG9zICsgaV0gKiBtYXhPdXRTYW1wbGUpIC8gbWF4SW5TYW1wbGUgKyAwLjVcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHB4UG9zICs9IDQ7XG4gICAgfVxuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKGluZGF0YSwgaW1hZ2VEYXRhLCBza2lwUmVzY2FsZSA9IGZhbHNlKSB7XG4gIGxldCBkZXB0aCA9IGltYWdlRGF0YS5kZXB0aDtcbiAgbGV0IHdpZHRoID0gaW1hZ2VEYXRhLndpZHRoO1xuICBsZXQgaGVpZ2h0ID0gaW1hZ2VEYXRhLmhlaWdodDtcbiAgbGV0IGNvbG9yVHlwZSA9IGltYWdlRGF0YS5jb2xvclR5cGU7XG4gIGxldCB0cmFuc0NvbG9yID0gaW1hZ2VEYXRhLnRyYW5zQ29sb3I7XG4gIGxldCBwYWxldHRlID0gaW1hZ2VEYXRhLnBhbGV0dGU7XG5cbiAgbGV0IG91dGRhdGEgPSBpbmRhdGE7IC8vIG9ubHkgZGlmZmVyZW50IGZvciAxNiBiaXRzXG5cbiAgaWYgKGNvbG9yVHlwZSA9PT0gMykge1xuICAgIC8vIHBhbGV0dGVkXG4gICAgZGVQYWxldHRlKGluZGF0YSwgb3V0ZGF0YSwgd2lkdGgsIGhlaWdodCwgcGFsZXR0ZSk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHRyYW5zQ29sb3IpIHtcbiAgICAgIHJlcGxhY2VUcmFuc3BhcmVudENvbG9yKGluZGF0YSwgb3V0ZGF0YSwgd2lkdGgsIGhlaWdodCwgdHJhbnNDb2xvcik7XG4gICAgfVxuICAgIC8vIGlmIGl0IG5lZWRzIHNjYWxpbmdcbiAgICBpZiAoZGVwdGggIT09IDggJiYgIXNraXBSZXNjYWxlKSB7XG4gICAgICAvLyBpZiB3ZSBuZWVkIHRvIGNoYW5nZSB0aGUgYnVmZmVyIHNpemVcbiAgICAgIGlmIChkZXB0aCA9PT0gMTYpIHtcbiAgICAgICAgb3V0ZGF0YSA9IEJ1ZmZlci5hbGxvYyh3aWR0aCAqIGhlaWdodCAqIDQpO1xuICAgICAgfVxuICAgICAgc2NhbGVEZXB0aChpbmRhdGEsIG91dGRhdGEsIHdpZHRoLCBoZWlnaHQsIGRlcHRoKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dGRhdGE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgdXRpbCA9IHJlcXVpcmUoXCJ1dGlsXCIpO1xubGV0IHpsaWIgPSByZXF1aXJlKFwiemxpYlwiKTtcbmxldCBDaHVua1N0cmVhbSA9IHJlcXVpcmUoXCIuL2NodW5rc3RyZWFtXCIpO1xubGV0IEZpbHRlckFzeW5jID0gcmVxdWlyZShcIi4vZmlsdGVyLXBhcnNlLWFzeW5jXCIpO1xubGV0IFBhcnNlciA9IHJlcXVpcmUoXCIuL3BhcnNlclwiKTtcbmxldCBiaXRtYXBwZXIgPSByZXF1aXJlKFwiLi9iaXRtYXBwZXJcIik7XG5sZXQgZm9ybWF0Tm9ybWFsaXNlciA9IHJlcXVpcmUoXCIuL2Zvcm1hdC1ub3JtYWxpc2VyXCIpO1xuXG5sZXQgUGFyc2VyQXN5bmMgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob3B0aW9ucykge1xuICBDaHVua1N0cmVhbS5jYWxsKHRoaXMpO1xuXG4gIHRoaXMuX3BhcnNlciA9IG5ldyBQYXJzZXIob3B0aW9ucywge1xuICAgIHJlYWQ6IHRoaXMucmVhZC5iaW5kKHRoaXMpLFxuICAgIGVycm9yOiB0aGlzLl9oYW5kbGVFcnJvci5iaW5kKHRoaXMpLFxuICAgIG1ldGFkYXRhOiB0aGlzLl9oYW5kbGVNZXRhRGF0YS5iaW5kKHRoaXMpLFxuICAgIGdhbW1hOiB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImdhbW1hXCIpLFxuICAgIHBhbGV0dGU6IHRoaXMuX2hhbmRsZVBhbGV0dGUuYmluZCh0aGlzKSxcbiAgICB0cmFuc0NvbG9yOiB0aGlzLl9oYW5kbGVUcmFuc0NvbG9yLmJpbmQodGhpcyksXG4gICAgZmluaXNoZWQ6IHRoaXMuX2ZpbmlzaGVkLmJpbmQodGhpcyksXG4gICAgaW5mbGF0ZURhdGE6IHRoaXMuX2luZmxhdGVEYXRhLmJpbmQodGhpcyksXG4gICAgc2ltcGxlVHJhbnNwYXJlbmN5OiB0aGlzLl9zaW1wbGVUcmFuc3BhcmVuY3kuYmluZCh0aGlzKSxcbiAgICBoZWFkZXJzRmluaXNoZWQ6IHRoaXMuX2hlYWRlcnNGaW5pc2hlZC5iaW5kKHRoaXMpLFxuICB9KTtcbiAgdGhpcy5fb3B0aW9ucyA9IG9wdGlvbnM7XG4gIHRoaXMud3JpdGFibGUgPSB0cnVlO1xuXG4gIHRoaXMuX3BhcnNlci5zdGFydCgpO1xufSk7XG51dGlsLmluaGVyaXRzKFBhcnNlckFzeW5jLCBDaHVua1N0cmVhbSk7XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGFuZGxlRXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gIHRoaXMuZW1pdChcImVycm9yXCIsIGVycik7XG5cbiAgdGhpcy53cml0YWJsZSA9IGZhbHNlO1xuXG4gIHRoaXMuZGVzdHJveSgpO1xuXG4gIGlmICh0aGlzLl9pbmZsYXRlICYmIHRoaXMuX2luZmxhdGUuZGVzdHJveSkge1xuICAgIHRoaXMuX2luZmxhdGUuZGVzdHJveSgpO1xuICB9XG5cbiAgaWYgKHRoaXMuX2ZpbHRlcikge1xuICAgIHRoaXMuX2ZpbHRlci5kZXN0cm95KCk7XG4gICAgLy8gRm9yIGJhY2t3YXJkIGNvbXBhdGliaWxpdHkgd2l0aCBOb2RlIDcgYW5kIGJlbG93LlxuICAgIC8vIFN1cHByZXNzIGVycm9ycyBkdWUgdG8gX2luZmxhdGUgY2FsbGluZyB3cml0ZSgpIGV2ZW4gYWZ0ZXJcbiAgICAvLyBpdCdzIGRlc3Ryb3koKSdlZC5cbiAgICB0aGlzLl9maWx0ZXIub24oXCJlcnJvclwiLCBmdW5jdGlvbiAoKSB7fSk7XG4gIH1cblxuICB0aGlzLmVycm9yZCA9IHRydWU7XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX2luZmxhdGVEYXRhID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgaWYgKCF0aGlzLl9pbmZsYXRlKSB7XG4gICAgaWYgKHRoaXMuX2JpdG1hcEluZm8uaW50ZXJsYWNlKSB7XG4gICAgICB0aGlzLl9pbmZsYXRlID0gemxpYi5jcmVhdGVJbmZsYXRlKCk7XG5cbiAgICAgIHRoaXMuX2luZmxhdGUub24oXCJlcnJvclwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpKTtcbiAgICAgIHRoaXMuX2ZpbHRlci5vbihcImNvbXBsZXRlXCIsIHRoaXMuX2NvbXBsZXRlLmJpbmQodGhpcykpO1xuXG4gICAgICB0aGlzLl9pbmZsYXRlLnBpcGUodGhpcy5fZmlsdGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGV0IHJvd1NpemUgPVxuICAgICAgICAoKHRoaXMuX2JpdG1hcEluZm8ud2lkdGggKlxuICAgICAgICAgIHRoaXMuX2JpdG1hcEluZm8uYnBwICpcbiAgICAgICAgICB0aGlzLl9iaXRtYXBJbmZvLmRlcHRoICtcbiAgICAgICAgICA3KSA+PlxuICAgICAgICAgIDMpICtcbiAgICAgICAgMTtcbiAgICAgIGxldCBpbWFnZVNpemUgPSByb3dTaXplICogdGhpcy5fYml0bWFwSW5mby5oZWlnaHQ7XG4gICAgICBsZXQgY2h1bmtTaXplID0gTWF0aC5tYXgoaW1hZ2VTaXplLCB6bGliLlpfTUlOX0NIVU5LKTtcblxuICAgICAgdGhpcy5faW5mbGF0ZSA9IHpsaWIuY3JlYXRlSW5mbGF0ZSh7IGNodW5rU2l6ZTogY2h1bmtTaXplIH0pO1xuICAgICAgbGV0IGxlZnRUb0luZmxhdGUgPSBpbWFnZVNpemU7XG5cbiAgICAgIGxldCBlbWl0RXJyb3IgPSB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpO1xuICAgICAgdGhpcy5faW5mbGF0ZS5vbihcImVycm9yXCIsIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgaWYgKCFsZWZ0VG9JbmZsYXRlKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgZW1pdEVycm9yKGVycik7XG4gICAgICB9KTtcbiAgICAgIHRoaXMuX2ZpbHRlci5vbihcImNvbXBsZXRlXCIsIHRoaXMuX2NvbXBsZXRlLmJpbmQodGhpcykpO1xuXG4gICAgICBsZXQgZmlsdGVyV3JpdGUgPSB0aGlzLl9maWx0ZXIud3JpdGUuYmluZCh0aGlzLl9maWx0ZXIpO1xuICAgICAgdGhpcy5faW5mbGF0ZS5vbihcImRhdGFcIiwgZnVuY3Rpb24gKGNodW5rKSB7XG4gICAgICAgIGlmICghbGVmdFRvSW5mbGF0ZSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjaHVuay5sZW5ndGggPiBsZWZ0VG9JbmZsYXRlKSB7XG4gICAgICAgICAgY2h1bmsgPSBjaHVuay5zbGljZSgwLCBsZWZ0VG9JbmZsYXRlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxlZnRUb0luZmxhdGUgLT0gY2h1bmsubGVuZ3RoO1xuXG4gICAgICAgIGZpbHRlcldyaXRlKGNodW5rKTtcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLl9pbmZsYXRlLm9uKFwiZW5kXCIsIHRoaXMuX2ZpbHRlci5lbmQuYmluZCh0aGlzLl9maWx0ZXIpKTtcbiAgICB9XG4gIH1cbiAgdGhpcy5faW5mbGF0ZS53cml0ZShkYXRhKTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGFuZGxlTWV0YURhdGEgPSBmdW5jdGlvbiAobWV0YURhdGEpIHtcbiAgdGhpcy5fbWV0YURhdGEgPSBtZXRhRGF0YTtcbiAgdGhpcy5fYml0bWFwSW5mbyA9IE9iamVjdC5jcmVhdGUobWV0YURhdGEpO1xuXG4gIHRoaXMuX2ZpbHRlciA9IG5ldyBGaWx0ZXJBc3luYyh0aGlzLl9iaXRtYXBJbmZvKTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGFuZGxlVHJhbnNDb2xvciA9IGZ1bmN0aW9uICh0cmFuc0NvbG9yKSB7XG4gIHRoaXMuX2JpdG1hcEluZm8udHJhbnNDb2xvciA9IHRyYW5zQ29sb3I7XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX2hhbmRsZVBhbGV0dGUgPSBmdW5jdGlvbiAocGFsZXR0ZSkge1xuICB0aGlzLl9iaXRtYXBJbmZvLnBhbGV0dGUgPSBwYWxldHRlO1xufTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9zaW1wbGVUcmFuc3BhcmVuY3kgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMuX21ldGFEYXRhLmFscGhhID0gdHJ1ZTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGVhZGVyc0ZpbmlzaGVkID0gZnVuY3Rpb24gKCkge1xuICAvLyBVcCB1bnRpbCB0aGlzIHBvaW50LCB3ZSBkb24ndCBrbm93IGlmIHdlIGhhdmUgYSB0Uk5TIGNodW5rIChhbHBoYSlcbiAgLy8gc28gd2UgY2FuJ3QgZW1pdCBtZXRhZGF0YSBhbnkgZWFybGllclxuICB0aGlzLmVtaXQoXCJtZXRhZGF0YVwiLCB0aGlzLl9tZXRhRGF0YSk7XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX2ZpbmlzaGVkID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5lcnJvcmQpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXRoaXMuX2luZmxhdGUpIHtcbiAgICB0aGlzLmVtaXQoXCJlcnJvclwiLCBcIk5vIEluZmxhdGUgYmxvY2tcIik7XG4gIH0gZWxzZSB7XG4gICAgLy8gbm8gbW9yZSBkYXRhIHRvIGluZmxhdGVcbiAgICB0aGlzLl9pbmZsYXRlLmVuZCgpO1xuICB9XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX2NvbXBsZXRlID0gZnVuY3Rpb24gKGZpbHRlcmVkRGF0YSkge1xuICBpZiAodGhpcy5lcnJvcmQpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBsZXQgbm9ybWFsaXNlZEJpdG1hcERhdGE7XG5cbiAgdHJ5IHtcbiAgICBsZXQgYml0bWFwRGF0YSA9IGJpdG1hcHBlci5kYXRhVG9CaXRNYXAoZmlsdGVyZWREYXRhLCB0aGlzLl9iaXRtYXBJbmZvKTtcblxuICAgIG5vcm1hbGlzZWRCaXRtYXBEYXRhID0gZm9ybWF0Tm9ybWFsaXNlcihcbiAgICAgIGJpdG1hcERhdGEsXG4gICAgICB0aGlzLl9iaXRtYXBJbmZvLFxuICAgICAgdGhpcy5fb3B0aW9ucy5za2lwUmVzY2FsZVxuICAgICk7XG4gICAgYml0bWFwRGF0YSA9IG51bGw7XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgdGhpcy5faGFuZGxlRXJyb3IoZXgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMuZW1pdChcInBhcnNlZFwiLCBub3JtYWxpc2VkQml0bWFwRGF0YSk7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChkYXRhSW4sIHdpZHRoLCBoZWlnaHQsIG9wdGlvbnMpIHtcbiAgbGV0IG91dEhhc0FscGhhID1cbiAgICBbY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQSwgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQV0uaW5kZXhPZihcbiAgICAgIG9wdGlvbnMuY29sb3JUeXBlXG4gICAgKSAhPT0gLTE7XG4gIGlmIChvcHRpb25zLmNvbG9yVHlwZSA9PT0gb3B0aW9ucy5pbnB1dENvbG9yVHlwZSkge1xuICAgIGxldCBiaWdFbmRpYW4gPSAoZnVuY3Rpb24gKCkge1xuICAgICAgbGV0IGJ1ZmZlciA9IG5ldyBBcnJheUJ1ZmZlcigyKTtcbiAgICAgIG5ldyBEYXRhVmlldyhidWZmZXIpLnNldEludDE2KDAsIDI1NiwgdHJ1ZSAvKiBsaXR0bGVFbmRpYW4gKi8pO1xuICAgICAgLy8gSW50MTZBcnJheSB1c2VzIHRoZSBwbGF0Zm9ybSdzIGVuZGlhbm5lc3MuXG4gICAgICByZXR1cm4gbmV3IEludDE2QXJyYXkoYnVmZmVyKVswXSAhPT0gMjU2O1xuICAgIH0pKCk7XG4gICAgLy8gSWYgbm8gbmVlZCB0byBjb252ZXJ0IHRvIGdyYXlzY2FsZSBhbmQgYWxwaGEgaXMgcHJlc2VudC9hYnNlbnQgaW4gYm90aCwgdGFrZSBhIGZhc3Qgcm91dGVcbiAgICBpZiAob3B0aW9ucy5iaXREZXB0aCA9PT0gOCB8fCAob3B0aW9ucy5iaXREZXB0aCA9PT0gMTYgJiYgYmlnRW5kaWFuKSkge1xuICAgICAgcmV0dXJuIGRhdGFJbjtcbiAgICB9XG4gIH1cblxuICAvLyBtYXAgdG8gYSBVSW50MTYgYXJyYXkgaWYgZGF0YSBpcyAxNmJpdCwgZml4IGVuZGlhbm5lc3MgYmVsb3dcbiAgbGV0IGRhdGEgPSBvcHRpb25zLmJpdERlcHRoICE9PSAxNiA/IGRhdGFJbiA6IG5ldyBVaW50MTZBcnJheShkYXRhSW4uYnVmZmVyKTtcblxuICBsZXQgbWF4VmFsdWUgPSAyNTU7XG4gIGxldCBpbkJwcCA9IGNvbnN0YW50cy5DT0xPUlRZUEVfVE9fQlBQX01BUFtvcHRpb25zLmlucHV0Q29sb3JUeXBlXTtcbiAgaWYgKGluQnBwID09PSA0ICYmICFvcHRpb25zLmlucHV0SGFzQWxwaGEpIHtcbiAgICBpbkJwcCA9IDM7XG4gIH1cbiAgbGV0IG91dEJwcCA9IGNvbnN0YW50cy5DT0xPUlRZUEVfVE9fQlBQX01BUFtvcHRpb25zLmNvbG9yVHlwZV07XG4gIGlmIChvcHRpb25zLmJpdERlcHRoID09PSAxNikge1xuICAgIG1heFZhbHVlID0gNjU1MzU7XG4gICAgb3V0QnBwICo9IDI7XG4gIH1cbiAgbGV0IG91dERhdGEgPSBCdWZmZXIuYWxsb2Mod2lkdGggKiBoZWlnaHQgKiBvdXRCcHApO1xuXG4gIGxldCBpbkluZGV4ID0gMDtcbiAgbGV0IG91dEluZGV4ID0gMDtcblxuICBsZXQgYmdDb2xvciA9IG9wdGlvbnMuYmdDb2xvciB8fCB7fTtcbiAgaWYgKGJnQ29sb3IucmVkID09PSB1bmRlZmluZWQpIHtcbiAgICBiZ0NvbG9yLnJlZCA9IG1heFZhbHVlO1xuICB9XG4gIGlmIChiZ0NvbG9yLmdyZWVuID09PSB1bmRlZmluZWQpIHtcbiAgICBiZ0NvbG9yLmdyZWVuID0gbWF4VmFsdWU7XG4gIH1cbiAgaWYgKGJnQ29sb3IuYmx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgYmdDb2xvci5ibHVlID0gbWF4VmFsdWU7XG4gIH1cblxuICBmdW5jdGlvbiBnZXRSR0JBKCkge1xuICAgIGxldCByZWQ7XG4gICAgbGV0IGdyZWVuO1xuICAgIGxldCBibHVlO1xuICAgIGxldCBhbHBoYSA9IG1heFZhbHVlO1xuICAgIHN3aXRjaCAob3B0aW9ucy5pbnB1dENvbG9yVHlwZSkge1xuICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBOlxuICAgICAgICBhbHBoYSA9IGRhdGFbaW5JbmRleCArIDNdO1xuICAgICAgICByZWQgPSBkYXRhW2luSW5kZXhdO1xuICAgICAgICBncmVlbiA9IGRhdGFbaW5JbmRleCArIDFdO1xuICAgICAgICBibHVlID0gZGF0YVtpbkluZGV4ICsgMl07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SOlxuICAgICAgICByZWQgPSBkYXRhW2luSW5kZXhdO1xuICAgICAgICBncmVlbiA9IGRhdGFbaW5JbmRleCArIDFdO1xuICAgICAgICBibHVlID0gZGF0YVtpbkluZGV4ICsgMl07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0FMUEhBOlxuICAgICAgICBhbHBoYSA9IGRhdGFbaW5JbmRleCArIDFdO1xuICAgICAgICByZWQgPSBkYXRhW2luSW5kZXhdO1xuICAgICAgICBncmVlbiA9IHJlZDtcbiAgICAgICAgYmx1ZSA9IHJlZDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfR1JBWVNDQUxFOlxuICAgICAgICByZWQgPSBkYXRhW2luSW5kZXhdO1xuICAgICAgICBncmVlbiA9IHJlZDtcbiAgICAgICAgYmx1ZSA9IHJlZDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJpbnB1dCBjb2xvciB0eXBlOlwiICtcbiAgICAgICAgICAgIG9wdGlvbnMuaW5wdXRDb2xvclR5cGUgK1xuICAgICAgICAgICAgXCIgaXMgbm90IHN1cHBvcnRlZCBhdCBwcmVzZW50XCJcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAob3B0aW9ucy5pbnB1dEhhc0FscGhhKSB7XG4gICAgICBpZiAoIW91dEhhc0FscGhhKSB7XG4gICAgICAgIGFscGhhIC89IG1heFZhbHVlO1xuICAgICAgICByZWQgPSBNYXRoLm1pbihcbiAgICAgICAgICBNYXRoLm1heChNYXRoLnJvdW5kKCgxIC0gYWxwaGEpICogYmdDb2xvci5yZWQgKyBhbHBoYSAqIHJlZCksIDApLFxuICAgICAgICAgIG1heFZhbHVlXG4gICAgICAgICk7XG4gICAgICAgIGdyZWVuID0gTWF0aC5taW4oXG4gICAgICAgICAgTWF0aC5tYXgoTWF0aC5yb3VuZCgoMSAtIGFscGhhKSAqIGJnQ29sb3IuZ3JlZW4gKyBhbHBoYSAqIGdyZWVuKSwgMCksXG4gICAgICAgICAgbWF4VmFsdWVcbiAgICAgICAgKTtcbiAgICAgICAgYmx1ZSA9IE1hdGgubWluKFxuICAgICAgICAgIE1hdGgubWF4KE1hdGgucm91bmQoKDEgLSBhbHBoYSkgKiBiZ0NvbG9yLmJsdWUgKyBhbHBoYSAqIGJsdWUpLCAwKSxcbiAgICAgICAgICBtYXhWYWx1ZVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4geyByZWQ6IHJlZCwgZ3JlZW46IGdyZWVuLCBibHVlOiBibHVlLCBhbHBoYTogYWxwaGEgfTtcbiAgfVxuXG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHdpZHRoOyB4KyspIHtcbiAgICAgIGxldCByZ2JhID0gZ2V0UkdCQShkYXRhLCBpbkluZGV4KTtcblxuICAgICAgc3dpdGNoIChvcHRpb25zLmNvbG9yVHlwZSkge1xuICAgICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1JfQUxQSEE6XG4gICAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUjpcbiAgICAgICAgICBpZiAob3B0aW9ucy5iaXREZXB0aCA9PT0gOCkge1xuICAgICAgICAgICAgb3V0RGF0YVtvdXRJbmRleF0gPSByZ2JhLnJlZDtcbiAgICAgICAgICAgIG91dERhdGFbb3V0SW5kZXggKyAxXSA9IHJnYmEuZ3JlZW47XG4gICAgICAgICAgICBvdXREYXRhW291dEluZGV4ICsgMl0gPSByZ2JhLmJsdWU7XG4gICAgICAgICAgICBpZiAob3V0SGFzQWxwaGEpIHtcbiAgICAgICAgICAgICAgb3V0RGF0YVtvdXRJbmRleCArIDNdID0gcmdiYS5hbHBoYTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3V0RGF0YS53cml0ZVVJbnQxNkJFKHJnYmEucmVkLCBvdXRJbmRleCk7XG4gICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUocmdiYS5ncmVlbiwgb3V0SW5kZXggKyAyKTtcbiAgICAgICAgICAgIG91dERhdGEud3JpdGVVSW50MTZCRShyZ2JhLmJsdWUsIG91dEluZGV4ICsgNCk7XG4gICAgICAgICAgICBpZiAob3V0SGFzQWxwaGEpIHtcbiAgICAgICAgICAgICAgb3V0RGF0YS53cml0ZVVJbnQxNkJFKHJnYmEuYWxwaGEsIG91dEluZGV4ICsgNik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQUxQSEE6XG4gICAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9HUkFZU0NBTEU6IHtcbiAgICAgICAgICAvLyBDb252ZXJ0IHRvIGdyYXlzY2FsZSBhbmQgYWxwaGFcbiAgICAgICAgICBsZXQgZ3JheXNjYWxlID0gKHJnYmEucmVkICsgcmdiYS5ncmVlbiArIHJnYmEuYmx1ZSkgLyAzO1xuICAgICAgICAgIGlmIChvcHRpb25zLmJpdERlcHRoID09PSA4KSB7XG4gICAgICAgICAgICBvdXREYXRhW291dEluZGV4XSA9IGdyYXlzY2FsZTtcbiAgICAgICAgICAgIGlmIChvdXRIYXNBbHBoYSkge1xuICAgICAgICAgICAgICBvdXREYXRhW291dEluZGV4ICsgMV0gPSByZ2JhLmFscGhhO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUoZ3JheXNjYWxlLCBvdXRJbmRleCk7XG4gICAgICAgICAgICBpZiAob3V0SGFzQWxwaGEpIHtcbiAgICAgICAgICAgICAgb3V0RGF0YS53cml0ZVVJbnQxNkJFKHJnYmEuYWxwaGEsIG91dEluZGV4ICsgMik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidW5yZWNvZ25pc2VkIGNvbG9yIFR5cGUgXCIgKyBvcHRpb25zLmNvbG9yVHlwZSk7XG4gICAgICB9XG5cbiAgICAgIGluSW5kZXggKz0gaW5CcHA7XG4gICAgICBvdXRJbmRleCArPSBvdXRCcHA7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG91dERhdGE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgcGFldGhQcmVkaWN0b3IgPSByZXF1aXJlKFwiLi9wYWV0aC1wcmVkaWN0b3JcIik7XG5cbmZ1bmN0aW9uIGZpbHRlck5vbmUocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCByYXdEYXRhLCByYXdQb3MpIHtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIHJhd0RhdGFbcmF3UG9zICsgeF0gPSBweERhdGFbcHhQb3MgKyB4XTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1Ob25lKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCkge1xuICBsZXQgc3VtID0gMDtcbiAgbGV0IGxlbmd0aCA9IHB4UG9zICsgYnl0ZVdpZHRoO1xuXG4gIGZvciAobGV0IGkgPSBweFBvczsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgc3VtICs9IE1hdGguYWJzKHB4RGF0YVtpXSk7XG4gIH1cbiAgcmV0dXJuIHN1bTtcbn1cblxuZnVuY3Rpb24gZmlsdGVyU3ViKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgcmF3RGF0YSwgcmF3UG9zLCBicHApIHtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCBsZWZ0ID0geCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnBwXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gbGVmdDtcblxuICAgIHJhd0RhdGFbcmF3UG9zICsgeF0gPSB2YWw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmlsdGVyU3VtU3ViKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgYnBwKSB7XG4gIGxldCBzdW0gPSAwO1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdmFsID0gcHhEYXRhW3B4UG9zICsgeF0gLSBsZWZ0O1xuXG4gICAgc3VtICs9IE1hdGguYWJzKHZhbCk7XG4gIH1cblxuICByZXR1cm4gc3VtO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJVcChweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIHJhd0RhdGEsIHJhd1Bvcykge1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IHVwID0gcHhQb3MgPiAwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbcHhQb3MgKyB4XSAtIHVwO1xuXG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHZhbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1VcChweERhdGEsIHB4UG9zLCBieXRlV2lkdGgpIHtcbiAgbGV0IHN1bSA9IDA7XG4gIGxldCBsZW5ndGggPSBweFBvcyArIGJ5dGVXaWR0aDtcbiAgZm9yIChsZXQgeCA9IHB4UG9zOyB4IDwgbGVuZ3RoOyB4KyspIHtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbeF0gLSB1cDtcblxuICAgIHN1bSArPSBNYXRoLmFicyh2YWwpO1xuICB9XG5cbiAgcmV0dXJuIHN1bTtcbn1cblxuZnVuY3Rpb24gZmlsdGVyQXZnKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgcmF3RGF0YSwgcmF3UG9zLCBicHApIHtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCBsZWZ0ID0geCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnBwXSA6IDA7XG4gICAgbGV0IHVwID0gcHhQb3MgPiAwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbcHhQb3MgKyB4XSAtICgobGVmdCArIHVwKSA+PiAxKTtcblxuICAgIHJhd0RhdGFbcmF3UG9zICsgeF0gPSB2YWw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmlsdGVyU3VtQXZnKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgYnBwKSB7XG4gIGxldCBzdW0gPSAwO1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gKChsZWZ0ICsgdXApID4+IDEpO1xuXG4gICAgc3VtICs9IE1hdGguYWJzKHZhbCk7XG4gIH1cblxuICByZXR1cm4gc3VtO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJQYWV0aChweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIHJhd0RhdGEsIHJhd1BvcywgYnBwKSB7XG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgbGVmdCA9IHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJwcF0gOiAwO1xuICAgIGxldCB1cCA9IHB4UG9zID4gMCA/IHB4RGF0YVtweFBvcyArIHggLSBieXRlV2lkdGhdIDogMDtcbiAgICBsZXQgdXBsZWZ0ID1cbiAgICAgIHB4UG9zID4gMCAmJiB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSAoYnl0ZVdpZHRoICsgYnBwKV0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbcHhQb3MgKyB4XSAtIHBhZXRoUHJlZGljdG9yKGxlZnQsIHVwLCB1cGxlZnQpO1xuXG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHZhbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1QYWV0aChweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIGJwcCkge1xuICBsZXQgc3VtID0gMDtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCBsZWZ0ID0geCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnBwXSA6IDA7XG4gICAgbGV0IHVwID0gcHhQb3MgPiAwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB1cGxlZnQgPVxuICAgICAgcHhQb3MgPiAwICYmIHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIChieXRlV2lkdGggKyBicHApXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gcGFldGhQcmVkaWN0b3IobGVmdCwgdXAsIHVwbGVmdCk7XG5cbiAgICBzdW0gKz0gTWF0aC5hYnModmFsKTtcbiAgfVxuXG4gIHJldHVybiBzdW07XG59XG5cbmxldCBmaWx0ZXJzID0ge1xuICAwOiBmaWx0ZXJOb25lLFxuICAxOiBmaWx0ZXJTdWIsXG4gIDI6IGZpbHRlclVwLFxuICAzOiBmaWx0ZXJBdmcsXG4gIDQ6IGZpbHRlclBhZXRoLFxufTtcblxubGV0IGZpbHRlclN1bXMgPSB7XG4gIDA6IGZpbHRlclN1bU5vbmUsXG4gIDE6IGZpbHRlclN1bVN1YixcbiAgMjogZmlsdGVyU3VtVXAsXG4gIDM6IGZpbHRlclN1bUF2ZyxcbiAgNDogZmlsdGVyU3VtUGFldGgsXG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChweERhdGEsIHdpZHRoLCBoZWlnaHQsIG9wdGlvbnMsIGJwcCkge1xuICBsZXQgZmlsdGVyVHlwZXM7XG4gIGlmICghKFwiZmlsdGVyVHlwZVwiIGluIG9wdGlvbnMpIHx8IG9wdGlvbnMuZmlsdGVyVHlwZSA9PT0gLTEpIHtcbiAgICBmaWx0ZXJUeXBlcyA9IFswLCAxLCAyLCAzLCA0XTtcbiAgfSBlbHNlIGlmICh0eXBlb2Ygb3B0aW9ucy5maWx0ZXJUeXBlID09PSBcIm51bWJlclwiKSB7XG4gICAgZmlsdGVyVHlwZXMgPSBbb3B0aW9ucy5maWx0ZXJUeXBlXTtcbiAgfSBlbHNlIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bnJlY29nbmlzZWQgZmlsdGVyIHR5cGVzXCIpO1xuICB9XG5cbiAgaWYgKG9wdGlvbnMuYml0RGVwdGggPT09IDE2KSB7XG4gICAgYnBwICo9IDI7XG4gIH1cbiAgbGV0IGJ5dGVXaWR0aCA9IHdpZHRoICogYnBwO1xuICBsZXQgcmF3UG9zID0gMDtcbiAgbGV0IHB4UG9zID0gMDtcbiAgbGV0IHJhd0RhdGEgPSBCdWZmZXIuYWxsb2MoKGJ5dGVXaWR0aCArIDEpICogaGVpZ2h0KTtcblxuICBsZXQgc2VsID0gZmlsdGVyVHlwZXNbMF07XG5cbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGlmIChmaWx0ZXJUeXBlcy5sZW5ndGggPiAxKSB7XG4gICAgICAvLyBmaW5kIGJlc3QgZmlsdGVyIGZvciB0aGlzIGxpbmUgKHdpdGggbG93ZXN0IHN1bSBvZiB2YWx1ZXMpXG4gICAgICBsZXQgbWluID0gSW5maW5pdHk7XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmlsdGVyVHlwZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgbGV0IHN1bSA9IGZpbHRlclN1bXNbZmlsdGVyVHlwZXNbaV1dKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgYnBwKTtcbiAgICAgICAgaWYgKHN1bSA8IG1pbikge1xuICAgICAgICAgIHNlbCA9IGZpbHRlclR5cGVzW2ldO1xuICAgICAgICAgIG1pbiA9IHN1bTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHJhd0RhdGFbcmF3UG9zXSA9IHNlbDtcbiAgICByYXdQb3MrKztcbiAgICBmaWx0ZXJzW3NlbF0ocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCByYXdEYXRhLCByYXdQb3MsIGJwcCk7XG4gICAgcmF3UG9zICs9IGJ5dGVXaWR0aDtcbiAgICBweFBvcyArPSBieXRlV2lkdGg7XG4gIH1cbiAgcmV0dXJuIHJhd0RhdGE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xubGV0IENyY1N0cmVhbSA9IHJlcXVpcmUoXCIuL2NyY1wiKTtcbmxldCBiaXRQYWNrZXIgPSByZXF1aXJlKFwiLi9iaXRwYWNrZXJcIik7XG5sZXQgZmlsdGVyID0gcmVxdWlyZShcIi4vZmlsdGVyLXBhY2tcIik7XG5sZXQgemxpYiA9IHJlcXVpcmUoXCJ6bGliXCIpO1xuXG5sZXQgUGFja2VyID0gKG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgdGhpcy5fb3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgb3B0aW9ucy5kZWZsYXRlQ2h1bmtTaXplID0gb3B0aW9ucy5kZWZsYXRlQ2h1bmtTaXplIHx8IDMyICogMTAyNDtcbiAgb3B0aW9ucy5kZWZsYXRlTGV2ZWwgPVxuICAgIG9wdGlvbnMuZGVmbGF0ZUxldmVsICE9IG51bGwgPyBvcHRpb25zLmRlZmxhdGVMZXZlbCA6IDk7XG4gIG9wdGlvbnMuZGVmbGF0ZVN0cmF0ZWd5ID1cbiAgICBvcHRpb25zLmRlZmxhdGVTdHJhdGVneSAhPSBudWxsID8gb3B0aW9ucy5kZWZsYXRlU3RyYXRlZ3kgOiAzO1xuICBvcHRpb25zLmlucHV0SGFzQWxwaGEgPVxuICAgIG9wdGlvbnMuaW5wdXRIYXNBbHBoYSAhPSBudWxsID8gb3B0aW9ucy5pbnB1dEhhc0FscGhhIDogdHJ1ZTtcbiAgb3B0aW9ucy5kZWZsYXRlRmFjdG9yeSA9IG9wdGlvbnMuZGVmbGF0ZUZhY3RvcnkgfHwgemxpYi5jcmVhdGVEZWZsYXRlO1xuICBvcHRpb25zLmJpdERlcHRoID0gb3B0aW9ucy5iaXREZXB0aCB8fCA4O1xuICAvLyBUaGlzIGlzIG91dHB1dENvbG9yVHlwZVxuICBvcHRpb25zLmNvbG9yVHlwZSA9XG4gICAgdHlwZW9mIG9wdGlvbnMuY29sb3JUeXBlID09PSBcIm51bWJlclwiXG4gICAgICA/IG9wdGlvbnMuY29sb3JUeXBlXG4gICAgICA6IGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1JfQUxQSEE7XG4gIG9wdGlvbnMuaW5wdXRDb2xvclR5cGUgPVxuICAgIHR5cGVvZiBvcHRpb25zLmlucHV0Q29sb3JUeXBlID09PSBcIm51bWJlclwiXG4gICAgICA/IG9wdGlvbnMuaW5wdXRDb2xvclR5cGVcbiAgICAgIDogY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQTtcblxuICBpZiAoXG4gICAgW1xuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9HUkFZU0NBTEUsXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SLFxuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQSxcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfQUxQSEEsXG4gICAgXS5pbmRleE9mKG9wdGlvbnMuY29sb3JUeXBlKSA9PT0gLTFcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJvcHRpb24gY29sb3IgdHlwZTpcIiArIG9wdGlvbnMuY29sb3JUeXBlICsgXCIgaXMgbm90IHN1cHBvcnRlZCBhdCBwcmVzZW50XCJcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBbXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0dSQVlTQ0FMRSxcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1IsXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBLFxuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQSxcbiAgICBdLmluZGV4T2Yob3B0aW9ucy5pbnB1dENvbG9yVHlwZSkgPT09IC0xXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwib3B0aW9uIGlucHV0IGNvbG9yIHR5cGU6XCIgK1xuICAgICAgICBvcHRpb25zLmlucHV0Q29sb3JUeXBlICtcbiAgICAgICAgXCIgaXMgbm90IHN1cHBvcnRlZCBhdCBwcmVzZW50XCJcbiAgICApO1xuICB9XG4gIGlmIChvcHRpb25zLmJpdERlcHRoICE9PSA4ICYmIG9wdGlvbnMuYml0RGVwdGggIT09IDE2KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJvcHRpb24gYml0IGRlcHRoOlwiICsgb3B0aW9ucy5iaXREZXB0aCArIFwiIGlzIG5vdCBzdXBwb3J0ZWQgYXQgcHJlc2VudFwiXG4gICAgKTtcbiAgfVxufSk7XG5cblBhY2tlci5wcm90b3R5cGUuZ2V0RGVmbGF0ZU9wdGlvbnMgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB7XG4gICAgY2h1bmtTaXplOiB0aGlzLl9vcHRpb25zLmRlZmxhdGVDaHVua1NpemUsXG4gICAgbGV2ZWw6IHRoaXMuX29wdGlvbnMuZGVmbGF0ZUxldmVsLFxuICAgIHN0cmF0ZWd5OiB0aGlzLl9vcHRpb25zLmRlZmxhdGVTdHJhdGVneSxcbiAgfTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUuY3JlYXRlRGVmbGF0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuX29wdGlvbnMuZGVmbGF0ZUZhY3RvcnkodGhpcy5nZXREZWZsYXRlT3B0aW9ucygpKTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUuZmlsdGVyRGF0YSA9IGZ1bmN0aW9uIChkYXRhLCB3aWR0aCwgaGVpZ2h0KSB7XG4gIC8vIGNvbnZlcnQgdG8gY29ycmVjdCBmb3JtYXQgZm9yIGZpbHRlcmluZyAoZS5nLiByaWdodCBicHAgYW5kIGJpdCBkZXB0aClcbiAgbGV0IHBhY2tlZERhdGEgPSBiaXRQYWNrZXIoZGF0YSwgd2lkdGgsIGhlaWdodCwgdGhpcy5fb3B0aW9ucyk7XG5cbiAgLy8gZmlsdGVyIHBpeGVsIGRhdGFcbiAgbGV0IGJwcCA9IGNvbnN0YW50cy5DT0xPUlRZUEVfVE9fQlBQX01BUFt0aGlzLl9vcHRpb25zLmNvbG9yVHlwZV07XG4gIGxldCBmaWx0ZXJlZERhdGEgPSBmaWx0ZXIocGFja2VkRGF0YSwgd2lkdGgsIGhlaWdodCwgdGhpcy5fb3B0aW9ucywgYnBwKTtcbiAgcmV0dXJuIGZpbHRlcmVkRGF0YTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUuX3BhY2tDaHVuayA9IGZ1bmN0aW9uICh0eXBlLCBkYXRhKSB7XG4gIGxldCBsZW4gPSBkYXRhID8gZGF0YS5sZW5ndGggOiAwO1xuICBsZXQgYnVmID0gQnVmZmVyLmFsbG9jKGxlbiArIDEyKTtcblxuICBidWYud3JpdGVVSW50MzJCRShsZW4sIDApO1xuICBidWYud3JpdGVVSW50MzJCRSh0eXBlLCA0KTtcblxuICBpZiAoZGF0YSkge1xuICAgIGRhdGEuY29weShidWYsIDgpO1xuICB9XG5cbiAgYnVmLndyaXRlSW50MzJCRShcbiAgICBDcmNTdHJlYW0uY3JjMzIoYnVmLnNsaWNlKDQsIGJ1Zi5sZW5ndGggLSA0KSksXG4gICAgYnVmLmxlbmd0aCAtIDRcbiAgKTtcbiAgcmV0dXJuIGJ1Zjtcbn07XG5cblBhY2tlci5wcm90b3R5cGUucGFja0dBTUEgPSBmdW5jdGlvbiAoZ2FtbWEpIHtcbiAgbGV0IGJ1ZiA9IEJ1ZmZlci5hbGxvYyg0KTtcbiAgYnVmLndyaXRlVUludDMyQkUoTWF0aC5mbG9vcihnYW1tYSAqIGNvbnN0YW50cy5HQU1NQV9ESVZJU0lPTiksIDApO1xuICByZXR1cm4gdGhpcy5fcGFja0NodW5rKGNvbnN0YW50cy5UWVBFX2dBTUEsIGJ1Zik7XG59O1xuXG5QYWNrZXIucHJvdG90eXBlLnBhY2tJSERSID0gZnVuY3Rpb24gKHdpZHRoLCBoZWlnaHQpIHtcbiAgbGV0IGJ1ZiA9IEJ1ZmZlci5hbGxvYygxMyk7XG4gIGJ1Zi53cml0ZVVJbnQzMkJFKHdpZHRoLCAwKTtcbiAgYnVmLndyaXRlVUludDMyQkUoaGVpZ2h0LCA0KTtcbiAgYnVmWzhdID0gdGhpcy5fb3B0aW9ucy5iaXREZXB0aDsgLy8gQml0IGRlcHRoXG4gIGJ1Zls5XSA9IHRoaXMuX29wdGlvbnMuY29sb3JUeXBlOyAvLyBjb2xvclR5cGVcbiAgYnVmWzEwXSA9IDA7IC8vIGNvbXByZXNzaW9uXG4gIGJ1ZlsxMV0gPSAwOyAvLyBmaWx0ZXJcbiAgYnVmWzEyXSA9IDA7IC8vIGludGVybGFjZVxuXG4gIHJldHVybiB0aGlzLl9wYWNrQ2h1bmsoY29uc3RhbnRzLlRZUEVfSUhEUiwgYnVmKTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUucGFja0lEQVQgPSBmdW5jdGlvbiAoZGF0YSkge1xuICByZXR1cm4gdGhpcy5fcGFja0NodW5rKGNvbnN0YW50cy5UWVBFX0lEQVQsIGRhdGEpO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5wYWNrSUVORCA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuX3BhY2tDaHVuayhjb25zdGFudHMuVFlQRV9JRU5ELCBudWxsKTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5sZXQgU3RyZWFtID0gcmVxdWlyZShcInN0cmVhbVwiKTtcbmxldCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XG5sZXQgUGFja2VyID0gcmVxdWlyZShcIi4vcGFja2VyXCIpO1xuXG5sZXQgUGFja2VyQXN5bmMgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob3B0KSB7XG4gIFN0cmVhbS5jYWxsKHRoaXMpO1xuXG4gIGxldCBvcHRpb25zID0gb3B0IHx8IHt9O1xuXG4gIHRoaXMuX3BhY2tlciA9IG5ldyBQYWNrZXIob3B0aW9ucyk7XG4gIHRoaXMuX2RlZmxhdGUgPSB0aGlzLl9wYWNrZXIuY3JlYXRlRGVmbGF0ZSgpO1xuXG4gIHRoaXMucmVhZGFibGUgPSB0cnVlO1xufSk7XG51dGlsLmluaGVyaXRzKFBhY2tlckFzeW5jLCBTdHJlYW0pO1xuXG5QYWNrZXJBc3luYy5wcm90b3R5cGUucGFjayA9IGZ1bmN0aW9uIChkYXRhLCB3aWR0aCwgaGVpZ2h0LCBnYW1tYSkge1xuICAvLyBTaWduYXR1cmVcbiAgdGhpcy5lbWl0KFwiZGF0YVwiLCBCdWZmZXIuZnJvbShjb25zdGFudHMuUE5HX1NJR05BVFVSRSkpO1xuICB0aGlzLmVtaXQoXCJkYXRhXCIsIHRoaXMuX3BhY2tlci5wYWNrSUhEUih3aWR0aCwgaGVpZ2h0KSk7XG5cbiAgaWYgKGdhbW1hKSB7XG4gICAgdGhpcy5lbWl0KFwiZGF0YVwiLCB0aGlzLl9wYWNrZXIucGFja0dBTUEoZ2FtbWEpKTtcbiAgfVxuXG4gIGxldCBmaWx0ZXJlZERhdGEgPSB0aGlzLl9wYWNrZXIuZmlsdGVyRGF0YShkYXRhLCB3aWR0aCwgaGVpZ2h0KTtcblxuICAvLyBjb21wcmVzcyBpdFxuICB0aGlzLl9kZWZsYXRlLm9uKFwiZXJyb3JcIiwgdGhpcy5lbWl0LmJpbmQodGhpcywgXCJlcnJvclwiKSk7XG5cbiAgdGhpcy5fZGVmbGF0ZS5vbihcbiAgICBcImRhdGFcIixcbiAgICBmdW5jdGlvbiAoY29tcHJlc3NlZERhdGEpIHtcbiAgICAgIHRoaXMuZW1pdChcImRhdGFcIiwgdGhpcy5fcGFja2VyLnBhY2tJREFUKGNvbXByZXNzZWREYXRhKSk7XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG5cbiAgdGhpcy5fZGVmbGF0ZS5vbihcbiAgICBcImVuZFwiLFxuICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgIHRoaXMuZW1pdChcImRhdGFcIiwgdGhpcy5fcGFja2VyLnBhY2tJRU5EKCkpO1xuICAgICAgdGhpcy5lbWl0KFwiZW5kXCIpO1xuICAgIH0uYmluZCh0aGlzKVxuICApO1xuXG4gIHRoaXMuX2RlZmxhdGUuZW5kKGZpbHRlcmVkRGF0YSk7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgYXNzZXJ0ID0gcmVxdWlyZShcImFzc2VydFwiKS5vaztcbmxldCB6bGliID0gcmVxdWlyZShcInpsaWJcIik7XG5sZXQgdXRpbCA9IHJlcXVpcmUoXCJ1dGlsXCIpO1xuXG5sZXQga01heExlbmd0aCA9IHJlcXVpcmUoXCJidWZmZXJcIikua01heExlbmd0aDtcblxuZnVuY3Rpb24gSW5mbGF0ZShvcHRzKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBJbmZsYXRlKSkge1xuICAgIHJldHVybiBuZXcgSW5mbGF0ZShvcHRzKTtcbiAgfVxuXG4gIGlmIChvcHRzICYmIG9wdHMuY2h1bmtTaXplIDwgemxpYi5aX01JTl9DSFVOSykge1xuICAgIG9wdHMuY2h1bmtTaXplID0gemxpYi5aX01JTl9DSFVOSztcbiAgfVxuXG4gIHpsaWIuSW5mbGF0ZS5jYWxsKHRoaXMsIG9wdHMpO1xuXG4gIC8vIE5vZGUgOCAtLT4gOSBjb21wYXRpYmlsaXR5IGNoZWNrXG4gIHRoaXMuX29mZnNldCA9IHRoaXMuX29mZnNldCA9PT0gdW5kZWZpbmVkID8gdGhpcy5fb3V0T2Zmc2V0IDogdGhpcy5fb2Zmc2V0O1xuICB0aGlzLl9idWZmZXIgPSB0aGlzLl9idWZmZXIgfHwgdGhpcy5fb3V0QnVmZmVyO1xuXG4gIGlmIChvcHRzICYmIG9wdHMubWF4TGVuZ3RoICE9IG51bGwpIHtcbiAgICB0aGlzLl9tYXhMZW5ndGggPSBvcHRzLm1heExlbmd0aDtcbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVJbmZsYXRlKG9wdHMpIHtcbiAgcmV0dXJuIG5ldyBJbmZsYXRlKG9wdHMpO1xufVxuXG5mdW5jdGlvbiBfY2xvc2UoZW5naW5lLCBjYWxsYmFjaykge1xuICBpZiAoY2FsbGJhY2spIHtcbiAgICBwcm9jZXNzLm5leHRUaWNrKGNhbGxiYWNrKTtcbiAgfVxuXG4gIC8vIENhbGxlciBtYXkgaW52b2tlIC5jbG9zZSBhZnRlciBhIHpsaWIgZXJyb3IgKHdoaWNoIHdpbGwgbnVsbCBfaGFuZGxlKS5cbiAgaWYgKCFlbmdpbmUuX2hhbmRsZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGVuZ2luZS5faGFuZGxlLmNsb3NlKCk7XG4gIGVuZ2luZS5faGFuZGxlID0gbnVsbDtcbn1cblxuSW5mbGF0ZS5wcm90b3R5cGUuX3Byb2Nlc3NDaHVuayA9IGZ1bmN0aW9uIChjaHVuaywgZmx1c2hGbGFnLCBhc3luY0NiKSB7XG4gIGlmICh0eXBlb2YgYXN5bmNDYiA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgcmV0dXJuIHpsaWIuSW5mbGF0ZS5fcHJvY2Vzc0NodW5rLmNhbGwodGhpcywgY2h1bmssIGZsdXNoRmxhZywgYXN5bmNDYik7XG4gIH1cblxuICBsZXQgc2VsZiA9IHRoaXM7XG5cbiAgbGV0IGF2YWlsSW5CZWZvcmUgPSBjaHVuayAmJiBjaHVuay5sZW5ndGg7XG4gIGxldCBhdmFpbE91dEJlZm9yZSA9IHRoaXMuX2NodW5rU2l6ZSAtIHRoaXMuX29mZnNldDtcbiAgbGV0IGxlZnRUb0luZmxhdGUgPSB0aGlzLl9tYXhMZW5ndGg7XG4gIGxldCBpbk9mZiA9IDA7XG5cbiAgbGV0IGJ1ZmZlcnMgPSBbXTtcbiAgbGV0IG5yZWFkID0gMDtcblxuICBsZXQgZXJyb3I7XG4gIHRoaXMub24oXCJlcnJvclwiLCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgZXJyb3IgPSBlcnI7XG4gIH0pO1xuXG4gIGZ1bmN0aW9uIGhhbmRsZUNodW5rKGF2YWlsSW5BZnRlciwgYXZhaWxPdXRBZnRlcikge1xuICAgIGlmIChzZWxmLl9oYWRFcnJvcikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCBoYXZlID0gYXZhaWxPdXRCZWZvcmUgLSBhdmFpbE91dEFmdGVyO1xuICAgIGFzc2VydChoYXZlID49IDAsIFwiaGF2ZSBzaG91bGQgbm90IGdvIGRvd25cIik7XG5cbiAgICBpZiAoaGF2ZSA+IDApIHtcbiAgICAgIGxldCBvdXQgPSBzZWxmLl9idWZmZXIuc2xpY2Uoc2VsZi5fb2Zmc2V0LCBzZWxmLl9vZmZzZXQgKyBoYXZlKTtcbiAgICAgIHNlbGYuX29mZnNldCArPSBoYXZlO1xuXG4gICAgICBpZiAob3V0Lmxlbmd0aCA+IGxlZnRUb0luZmxhdGUpIHtcbiAgICAgICAgb3V0ID0gb3V0LnNsaWNlKDAsIGxlZnRUb0luZmxhdGUpO1xuICAgICAgfVxuXG4gICAgICBidWZmZXJzLnB1c2gob3V0KTtcbiAgICAgIG5yZWFkICs9IG91dC5sZW5ndGg7XG4gICAgICBsZWZ0VG9JbmZsYXRlIC09IG91dC5sZW5ndGg7XG5cbiAgICAgIGlmIChsZWZ0VG9JbmZsYXRlID09PSAwKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoYXZhaWxPdXRBZnRlciA9PT0gMCB8fCBzZWxmLl9vZmZzZXQgPj0gc2VsZi5fY2h1bmtTaXplKSB7XG4gICAgICBhdmFpbE91dEJlZm9yZSA9IHNlbGYuX2NodW5rU2l6ZTtcbiAgICAgIHNlbGYuX29mZnNldCA9IDA7XG4gICAgICBzZWxmLl9idWZmZXIgPSBCdWZmZXIuYWxsb2NVbnNhZmUoc2VsZi5fY2h1bmtTaXplKTtcbiAgICB9XG5cbiAgICBpZiAoYXZhaWxPdXRBZnRlciA9PT0gMCkge1xuICAgICAgaW5PZmYgKz0gYXZhaWxJbkJlZm9yZSAtIGF2YWlsSW5BZnRlcjtcbiAgICAgIGF2YWlsSW5CZWZvcmUgPSBhdmFpbEluQWZ0ZXI7XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGFzc2VydCh0aGlzLl9oYW5kbGUsIFwiemxpYiBiaW5kaW5nIGNsb3NlZFwiKTtcbiAgbGV0IHJlcztcbiAgZG8ge1xuICAgIHJlcyA9IHRoaXMuX2hhbmRsZS53cml0ZVN5bmMoXG4gICAgICBmbHVzaEZsYWcsXG4gICAgICBjaHVuaywgLy8gaW5cbiAgICAgIGluT2ZmLCAvLyBpbl9vZmZcbiAgICAgIGF2YWlsSW5CZWZvcmUsIC8vIGluX2xlblxuICAgICAgdGhpcy5fYnVmZmVyLCAvLyBvdXRcbiAgICAgIHRoaXMuX29mZnNldCwgLy9vdXRfb2ZmXG4gICAgICBhdmFpbE91dEJlZm9yZVxuICAgICk7IC8vIG91dF9sZW5cbiAgICAvLyBOb2RlIDggLS0+IDkgY29tcGF0aWJpbGl0eSBjaGVja1xuICAgIHJlcyA9IHJlcyB8fCB0aGlzLl93cml0ZVN0YXRlO1xuICB9IHdoaWxlICghdGhpcy5faGFkRXJyb3IgJiYgaGFuZGxlQ2h1bmsocmVzWzBdLCByZXNbMV0pKTtcblxuICBpZiAodGhpcy5faGFkRXJyb3IpIHtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIGlmIChucmVhZCA+PSBrTWF4TGVuZ3RoKSB7XG4gICAgX2Nsb3NlKHRoaXMpO1xuICAgIHRocm93IG5ldyBSYW5nZUVycm9yKFxuICAgICAgXCJDYW5ub3QgY3JlYXRlIGZpbmFsIEJ1ZmZlci4gSXQgd291bGQgYmUgbGFyZ2VyIHRoYW4gMHhcIiArXG4gICAgICAgIGtNYXhMZW5ndGgudG9TdHJpbmcoMTYpICtcbiAgICAgICAgXCIgYnl0ZXNcIlxuICAgICk7XG4gIH1cblxuICBsZXQgYnVmID0gQnVmZmVyLmNvbmNhdChidWZmZXJzLCBucmVhZCk7XG4gIF9jbG9zZSh0aGlzKTtcblxuICByZXR1cm4gYnVmO1xufTtcblxudXRpbC5pbmhlcml0cyhJbmZsYXRlLCB6bGliLkluZmxhdGUpO1xuXG5mdW5jdGlvbiB6bGliQnVmZmVyU3luYyhlbmdpbmUsIGJ1ZmZlcikge1xuICBpZiAodHlwZW9mIGJ1ZmZlciA9PT0gXCJzdHJpbmdcIikge1xuICAgIGJ1ZmZlciA9IEJ1ZmZlci5mcm9tKGJ1ZmZlcik7XG4gIH1cbiAgaWYgKCEoYnVmZmVyIGluc3RhbmNlb2YgQnVmZmVyKSkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJOb3QgYSBzdHJpbmcgb3IgYnVmZmVyXCIpO1xuICB9XG5cbiAgbGV0IGZsdXNoRmxhZyA9IGVuZ2luZS5fZmluaXNoRmx1c2hGbGFnO1xuICBpZiAoZmx1c2hGbGFnID09IG51bGwpIHtcbiAgICBmbHVzaEZsYWcgPSB6bGliLlpfRklOSVNIO1xuICB9XG5cbiAgcmV0dXJuIGVuZ2luZS5fcHJvY2Vzc0NodW5rKGJ1ZmZlciwgZmx1c2hGbGFnKTtcbn1cblxuZnVuY3Rpb24gaW5mbGF0ZVN5bmMoYnVmZmVyLCBvcHRzKSB7XG4gIHJldHVybiB6bGliQnVmZmVyU3luYyhuZXcgSW5mbGF0ZShvcHRzKSwgYnVmZmVyKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzID0gaW5mbGF0ZVN5bmM7XG5leHBvcnRzLkluZmxhdGUgPSBJbmZsYXRlO1xuZXhwb3J0cy5jcmVhdGVJbmZsYXRlID0gY3JlYXRlSW5mbGF0ZTtcbmV4cG9ydHMuaW5mbGF0ZVN5bmMgPSBpbmZsYXRlU3luYztcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IFN5bmNSZWFkZXIgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoYnVmZmVyKSB7XG4gIHRoaXMuX2J1ZmZlciA9IGJ1ZmZlcjtcbiAgdGhpcy5fcmVhZHMgPSBbXTtcbn0pO1xuXG5TeW5jUmVhZGVyLnByb3RvdHlwZS5yZWFkID0gZnVuY3Rpb24gKGxlbmd0aCwgY2FsbGJhY2spIHtcbiAgdGhpcy5fcmVhZHMucHVzaCh7XG4gICAgbGVuZ3RoOiBNYXRoLmFicyhsZW5ndGgpLCAvLyBpZiBsZW5ndGggPCAwIHRoZW4gYXQgbW9zdCB0aGlzIGxlbmd0aFxuICAgIGFsbG93TGVzczogbGVuZ3RoIDwgMCxcbiAgICBmdW5jOiBjYWxsYmFjayxcbiAgfSk7XG59O1xuXG5TeW5jUmVhZGVyLnByb3RvdHlwZS5wcm9jZXNzID0gZnVuY3Rpb24gKCkge1xuICAvLyBhcyBsb25nIGFzIHRoZXJlIGlzIGFueSBkYXRhIGFuZCByZWFkIHJlcXVlc3RzXG4gIHdoaWxlICh0aGlzLl9yZWFkcy5sZW5ndGggPiAwICYmIHRoaXMuX2J1ZmZlci5sZW5ndGgpIHtcbiAgICBsZXQgcmVhZCA9IHRoaXMuX3JlYWRzWzBdO1xuXG4gICAgaWYgKFxuICAgICAgdGhpcy5fYnVmZmVyLmxlbmd0aCAmJlxuICAgICAgKHRoaXMuX2J1ZmZlci5sZW5ndGggPj0gcmVhZC5sZW5ndGggfHwgcmVhZC5hbGxvd0xlc3MpXG4gICAgKSB7XG4gICAgICAvLyBvayB0aGVyZSBpcyBhbnkgZGF0YSBzbyB0aGF0IHdlIGNhbiBzYXRpc2Z5IHRoaXMgcmVxdWVzdFxuICAgICAgdGhpcy5fcmVhZHMuc2hpZnQoKTsgLy8gPT0gcmVhZFxuXG4gICAgICBsZXQgYnVmID0gdGhpcy5fYnVmZmVyO1xuXG4gICAgICB0aGlzLl9idWZmZXIgPSBidWYuc2xpY2UocmVhZC5sZW5ndGgpO1xuXG4gICAgICByZWFkLmZ1bmMuY2FsbCh0aGlzLCBidWYuc2xpY2UoMCwgcmVhZC5sZW5ndGgpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgaWYgKHRoaXMuX3JlYWRzLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJUaGVyZSBhcmUgc29tZSByZWFkIHJlcXVlc3RzIHdhaXRuZyBvbiBmaW5pc2hlZCBzdHJlYW1cIik7XG4gIH1cblxuICBpZiAodGhpcy5fYnVmZmVyLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bnJlY29nbmlzZWQgY29udGVudCBhdCBlbmQgb2Ygc3RyZWFtXCIpO1xuICB9XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgU3luY1JlYWRlciA9IHJlcXVpcmUoXCIuL3N5bmMtcmVhZGVyXCIpO1xubGV0IEZpbHRlciA9IHJlcXVpcmUoXCIuL2ZpbHRlci1wYXJzZVwiKTtcblxuZXhwb3J0cy5wcm9jZXNzID0gZnVuY3Rpb24gKGluQnVmZmVyLCBiaXRtYXBJbmZvKSB7XG4gIGxldCBvdXRCdWZmZXJzID0gW107XG4gIGxldCByZWFkZXIgPSBuZXcgU3luY1JlYWRlcihpbkJ1ZmZlcik7XG4gIGxldCBmaWx0ZXIgPSBuZXcgRmlsdGVyKGJpdG1hcEluZm8sIHtcbiAgICByZWFkOiByZWFkZXIucmVhZC5iaW5kKHJlYWRlciksXG4gICAgd3JpdGU6IGZ1bmN0aW9uIChidWZmZXJQYXJ0KSB7XG4gICAgICBvdXRCdWZmZXJzLnB1c2goYnVmZmVyUGFydCk7XG4gICAgfSxcbiAgICBjb21wbGV0ZTogZnVuY3Rpb24gKCkge30sXG4gIH0pO1xuXG4gIGZpbHRlci5zdGFydCgpO1xuICByZWFkZXIucHJvY2VzcygpO1xuXG4gIHJldHVybiBCdWZmZXIuY29uY2F0KG91dEJ1ZmZlcnMpO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGhhc1N5bmNabGliID0gdHJ1ZTtcbmxldCB6bGliID0gcmVxdWlyZShcInpsaWJcIik7XG5sZXQgaW5mbGF0ZVN5bmMgPSByZXF1aXJlKFwiLi9zeW5jLWluZmxhdGVcIik7XG5pZiAoIXpsaWIuZGVmbGF0ZVN5bmMpIHtcbiAgaGFzU3luY1psaWIgPSBmYWxzZTtcbn1cbmxldCBTeW5jUmVhZGVyID0gcmVxdWlyZShcIi4vc3luYy1yZWFkZXJcIik7XG5sZXQgRmlsdGVyU3luYyA9IHJlcXVpcmUoXCIuL2ZpbHRlci1wYXJzZS1zeW5jXCIpO1xubGV0IFBhcnNlciA9IHJlcXVpcmUoXCIuL3BhcnNlclwiKTtcbmxldCBiaXRtYXBwZXIgPSByZXF1aXJlKFwiLi9iaXRtYXBwZXJcIik7XG5sZXQgZm9ybWF0Tm9ybWFsaXNlciA9IHJlcXVpcmUoXCIuL2Zvcm1hdC1ub3JtYWxpc2VyXCIpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChidWZmZXIsIG9wdGlvbnMpIHtcbiAgaWYgKCFoYXNTeW5jWmxpYikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiVG8gdXNlIHRoZSBzeW5jIGNhcGFiaWxpdHkgb2YgdGhpcyBsaWJyYXJ5IGluIG9sZCBub2RlIHZlcnNpb25zLCBwbGVhc2UgcGluIHBuZ2pzIHRvIHYyLjMuMFwiXG4gICAgKTtcbiAgfVxuXG4gIGxldCBlcnI7XG4gIGZ1bmN0aW9uIGhhbmRsZUVycm9yKF9lcnJfKSB7XG4gICAgZXJyID0gX2Vycl87XG4gIH1cblxuICBsZXQgbWV0YURhdGE7XG4gIGZ1bmN0aW9uIGhhbmRsZU1ldGFEYXRhKF9tZXRhRGF0YV8pIHtcbiAgICBtZXRhRGF0YSA9IF9tZXRhRGF0YV87XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVUcmFuc0NvbG9yKHRyYW5zQ29sb3IpIHtcbiAgICBtZXRhRGF0YS50cmFuc0NvbG9yID0gdHJhbnNDb2xvcjtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVBhbGV0dGUocGFsZXR0ZSkge1xuICAgIG1ldGFEYXRhLnBhbGV0dGUgPSBwYWxldHRlO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlU2ltcGxlVHJhbnNwYXJlbmN5KCkge1xuICAgIG1ldGFEYXRhLmFscGhhID0gdHJ1ZTtcbiAgfVxuXG4gIGxldCBnYW1tYTtcbiAgZnVuY3Rpb24gaGFuZGxlR2FtbWEoX2dhbW1hXykge1xuICAgIGdhbW1hID0gX2dhbW1hXztcbiAgfVxuXG4gIGxldCBpbmZsYXRlRGF0YUxpc3QgPSBbXTtcbiAgZnVuY3Rpb24gaGFuZGxlSW5mbGF0ZURhdGEoaW5mbGF0ZWREYXRhKSB7XG4gICAgaW5mbGF0ZURhdGFMaXN0LnB1c2goaW5mbGF0ZWREYXRhKTtcbiAgfVxuXG4gIGxldCByZWFkZXIgPSBuZXcgU3luY1JlYWRlcihidWZmZXIpO1xuXG4gIGxldCBwYXJzZXIgPSBuZXcgUGFyc2VyKG9wdGlvbnMsIHtcbiAgICByZWFkOiByZWFkZXIucmVhZC5iaW5kKHJlYWRlciksXG4gICAgZXJyb3I6IGhhbmRsZUVycm9yLFxuICAgIG1ldGFkYXRhOiBoYW5kbGVNZXRhRGF0YSxcbiAgICBnYW1tYTogaGFuZGxlR2FtbWEsXG4gICAgcGFsZXR0ZTogaGFuZGxlUGFsZXR0ZSxcbiAgICB0cmFuc0NvbG9yOiBoYW5kbGVUcmFuc0NvbG9yLFxuICAgIGluZmxhdGVEYXRhOiBoYW5kbGVJbmZsYXRlRGF0YSxcbiAgICBzaW1wbGVUcmFuc3BhcmVuY3k6IGhhbmRsZVNpbXBsZVRyYW5zcGFyZW5jeSxcbiAgfSk7XG5cbiAgcGFyc2VyLnN0YXJ0KCk7XG4gIHJlYWRlci5wcm9jZXNzKCk7XG5cbiAgaWYgKGVycikge1xuICAgIHRocm93IGVycjtcbiAgfVxuXG4gIC8vam9pbiB0b2dldGhlciB0aGUgaW5mbGF0ZSBkYXRhc1xuICBsZXQgaW5mbGF0ZURhdGEgPSBCdWZmZXIuY29uY2F0KGluZmxhdGVEYXRhTGlzdCk7XG4gIGluZmxhdGVEYXRhTGlzdC5sZW5ndGggPSAwO1xuXG4gIGxldCBpbmZsYXRlZERhdGE7XG4gIGlmIChtZXRhRGF0YS5pbnRlcmxhY2UpIHtcbiAgICBpbmZsYXRlZERhdGEgPSB6bGliLmluZmxhdGVTeW5jKGluZmxhdGVEYXRhKTtcbiAgfSBlbHNlIHtcbiAgICBsZXQgcm93U2l6ZSA9XG4gICAgICAoKG1ldGFEYXRhLndpZHRoICogbWV0YURhdGEuYnBwICogbWV0YURhdGEuZGVwdGggKyA3KSA+PiAzKSArIDE7XG4gICAgbGV0IGltYWdlU2l6ZSA9IHJvd1NpemUgKiBtZXRhRGF0YS5oZWlnaHQ7XG4gICAgaW5mbGF0ZWREYXRhID0gaW5mbGF0ZVN5bmMoaW5mbGF0ZURhdGEsIHtcbiAgICAgIGNodW5rU2l6ZTogaW1hZ2VTaXplLFxuICAgICAgbWF4TGVuZ3RoOiBpbWFnZVNpemUsXG4gICAgfSk7XG4gIH1cbiAgaW5mbGF0ZURhdGEgPSBudWxsO1xuXG4gIGlmICghaW5mbGF0ZWREYXRhIHx8ICFpbmZsYXRlZERhdGEubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiYmFkIHBuZyAtIGludmFsaWQgaW5mbGF0ZSBkYXRhIHJlc3BvbnNlXCIpO1xuICB9XG5cbiAgbGV0IHVuZmlsdGVyZWREYXRhID0gRmlsdGVyU3luYy5wcm9jZXNzKGluZmxhdGVkRGF0YSwgbWV0YURhdGEpO1xuICBpbmZsYXRlRGF0YSA9IG51bGw7XG5cbiAgbGV0IGJpdG1hcERhdGEgPSBiaXRtYXBwZXIuZGF0YVRvQml0TWFwKHVuZmlsdGVyZWREYXRhLCBtZXRhRGF0YSk7XG4gIHVuZmlsdGVyZWREYXRhID0gbnVsbDtcblxuICBsZXQgbm9ybWFsaXNlZEJpdG1hcERhdGEgPSBmb3JtYXROb3JtYWxpc2VyKFxuICAgIGJpdG1hcERhdGEsXG4gICAgbWV0YURhdGEsXG4gICAgb3B0aW9ucy5za2lwUmVzY2FsZVxuICApO1xuXG4gIG1ldGFEYXRhLmRhdGEgPSBub3JtYWxpc2VkQml0bWFwRGF0YTtcbiAgbWV0YURhdGEuZ2FtbWEgPSBnYW1tYSB8fCAwO1xuXG4gIHJldHVybiBtZXRhRGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBoYXNTeW5jWmxpYiA9IHRydWU7XG5sZXQgemxpYiA9IHJlcXVpcmUoXCJ6bGliXCIpO1xuaWYgKCF6bGliLmRlZmxhdGVTeW5jKSB7XG4gIGhhc1N5bmNabGliID0gZmFsc2U7XG59XG5sZXQgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xubGV0IFBhY2tlciA9IHJlcXVpcmUoXCIuL3BhY2tlclwiKTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAobWV0YURhdGEsIG9wdCkge1xuICBpZiAoIWhhc1N5bmNabGliKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJUbyB1c2UgdGhlIHN5bmMgY2FwYWJpbGl0eSBvZiB0aGlzIGxpYnJhcnkgaW4gb2xkIG5vZGUgdmVyc2lvbnMsIHBsZWFzZSBwaW4gcG5nanMgdG8gdjIuMy4wXCJcbiAgICApO1xuICB9XG5cbiAgbGV0IG9wdGlvbnMgPSBvcHQgfHwge307XG5cbiAgbGV0IHBhY2tlciA9IG5ldyBQYWNrZXIob3B0aW9ucyk7XG5cbiAgbGV0IGNodW5rcyA9IFtdO1xuXG4gIC8vIFNpZ25hdHVyZVxuICBjaHVua3MucHVzaChCdWZmZXIuZnJvbShjb25zdGFudHMuUE5HX1NJR05BVFVSRSkpO1xuXG4gIC8vIEhlYWRlclxuICBjaHVua3MucHVzaChwYWNrZXIucGFja0lIRFIobWV0YURhdGEud2lkdGgsIG1ldGFEYXRhLmhlaWdodCkpO1xuXG4gIGlmIChtZXRhRGF0YS5nYW1tYSkge1xuICAgIGNodW5rcy5wdXNoKHBhY2tlci5wYWNrR0FNQShtZXRhRGF0YS5nYW1tYSkpO1xuICB9XG5cbiAgbGV0IGZpbHRlcmVkRGF0YSA9IHBhY2tlci5maWx0ZXJEYXRhKFxuICAgIG1ldGFEYXRhLmRhdGEsXG4gICAgbWV0YURhdGEud2lkdGgsXG4gICAgbWV0YURhdGEuaGVpZ2h0XG4gICk7XG5cbiAgLy8gY29tcHJlc3MgaXRcbiAgbGV0IGNvbXByZXNzZWREYXRhID0gemxpYi5kZWZsYXRlU3luYyhcbiAgICBmaWx0ZXJlZERhdGEsXG4gICAgcGFja2VyLmdldERlZmxhdGVPcHRpb25zKClcbiAgKTtcbiAgZmlsdGVyZWREYXRhID0gbnVsbDtcblxuICBpZiAoIWNvbXByZXNzZWREYXRhIHx8ICFjb21wcmVzc2VkRGF0YS5sZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJiYWQgcG5nIC0gaW52YWxpZCBjb21wcmVzc2VkIGRhdGEgcmVzcG9uc2VcIik7XG4gIH1cbiAgY2h1bmtzLnB1c2gocGFja2VyLnBhY2tJREFUKGNvbXByZXNzZWREYXRhKSk7XG5cbiAgLy8gRW5kXG4gIGNodW5rcy5wdXNoKHBhY2tlci5wYWNrSUVORCgpKTtcblxuICByZXR1cm4gQnVmZmVyLmNvbmNhdChjaHVua3MpO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IHBhcnNlID0gcmVxdWlyZShcIi4vcGFyc2VyLXN5bmNcIik7XG5sZXQgcGFjayA9IHJlcXVpcmUoXCIuL3BhY2tlci1zeW5jXCIpO1xuXG5leHBvcnRzLnJlYWQgPSBmdW5jdGlvbiAoYnVmZmVyLCBvcHRpb25zKSB7XG4gIHJldHVybiBwYXJzZShidWZmZXIsIG9wdGlvbnMgfHwge30pO1xufTtcblxuZXhwb3J0cy53cml0ZSA9IGZ1bmN0aW9uIChwbmcsIG9wdGlvbnMpIHtcbiAgcmV0dXJuIHBhY2socG5nLCBvcHRpb25zKTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5sZXQgU3RyZWFtID0gcmVxdWlyZShcInN0cmVhbVwiKTtcbmxldCBQYXJzZXIgPSByZXF1aXJlKFwiLi9wYXJzZXItYXN5bmNcIik7XG5sZXQgUGFja2VyID0gcmVxdWlyZShcIi4vcGFja2VyLWFzeW5jXCIpO1xubGV0IFBOR1N5bmMgPSByZXF1aXJlKFwiLi9wbmctc3luY1wiKTtcblxubGV0IFBORyA9IChleHBvcnRzLlBORyA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIFN0cmVhbS5jYWxsKHRoaXMpO1xuXG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9OyAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG5vLXBhcmFtLXJlYXNzaWduXG5cbiAgLy8gY29lcmNlIHBpeGVsIGRpbWVuc2lvbnMgdG8gaW50ZWdlcnMgKGFsc28gY29lcmNlcyB1bmRlZmluZWQgLT4gMCk6XG4gIHRoaXMud2lkdGggPSBvcHRpb25zLndpZHRoIHwgMDtcbiAgdGhpcy5oZWlnaHQgPSBvcHRpb25zLmhlaWdodCB8IDA7XG5cbiAgdGhpcy5kYXRhID1cbiAgICB0aGlzLndpZHRoID4gMCAmJiB0aGlzLmhlaWdodCA+IDBcbiAgICAgID8gQnVmZmVyLmFsbG9jKDQgKiB0aGlzLndpZHRoICogdGhpcy5oZWlnaHQpXG4gICAgICA6IG51bGw7XG5cbiAgaWYgKG9wdGlvbnMuZmlsbCAmJiB0aGlzLmRhdGEpIHtcbiAgICB0aGlzLmRhdGEuZmlsbCgwKTtcbiAgfVxuXG4gIHRoaXMuZ2FtbWEgPSAwO1xuICB0aGlzLnJlYWRhYmxlID0gdGhpcy53cml0YWJsZSA9IHRydWU7XG5cbiAgdGhpcy5fcGFyc2VyID0gbmV3IFBhcnNlcihvcHRpb25zKTtcblxuICB0aGlzLl9wYXJzZXIub24oXCJlcnJvclwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpKTtcbiAgdGhpcy5fcGFyc2VyLm9uKFwiY2xvc2VcIiwgdGhpcy5faGFuZGxlQ2xvc2UuYmluZCh0aGlzKSk7XG4gIHRoaXMuX3BhcnNlci5vbihcIm1ldGFkYXRhXCIsIHRoaXMuX21ldGFkYXRhLmJpbmQodGhpcykpO1xuICB0aGlzLl9wYXJzZXIub24oXCJnYW1tYVwiLCB0aGlzLl9nYW1tYS5iaW5kKHRoaXMpKTtcbiAgdGhpcy5fcGFyc2VyLm9uKFxuICAgIFwicGFyc2VkXCIsXG4gICAgZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgIHRoaXMuZGF0YSA9IGRhdGE7XG4gICAgICB0aGlzLmVtaXQoXCJwYXJzZWRcIiwgZGF0YSk7XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG5cbiAgdGhpcy5fcGFja2VyID0gbmV3IFBhY2tlcihvcHRpb25zKTtcbiAgdGhpcy5fcGFja2VyLm9uKFwiZGF0YVwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImRhdGFcIikpO1xuICB0aGlzLl9wYWNrZXIub24oXCJlbmRcIiwgdGhpcy5lbWl0LmJpbmQodGhpcywgXCJlbmRcIikpO1xuICB0aGlzLl9wYXJzZXIub24oXCJjbG9zZVwiLCB0aGlzLl9oYW5kbGVDbG9zZS5iaW5kKHRoaXMpKTtcbiAgdGhpcy5fcGFja2VyLm9uKFwiZXJyb3JcIiwgdGhpcy5lbWl0LmJpbmQodGhpcywgXCJlcnJvclwiKSk7XG59KTtcbnV0aWwuaW5oZXJpdHMoUE5HLCBTdHJlYW0pO1xuXG5QTkcuc3luYyA9IFBOR1N5bmM7XG5cblBORy5wcm90b3R5cGUucGFjayA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmRhdGEgfHwgIXRoaXMuZGF0YS5sZW5ndGgpIHtcbiAgICB0aGlzLmVtaXQoXCJlcnJvclwiLCBcIk5vIGRhdGEgcHJvdmlkZWRcIik7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBwcm9jZXNzLm5leHRUaWNrKFxuICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgIHRoaXMuX3BhY2tlci5wYWNrKHRoaXMuZGF0YSwgdGhpcy53aWR0aCwgdGhpcy5oZWlnaHQsIHRoaXMuZ2FtbWEpO1xuICAgIH0uYmluZCh0aGlzKVxuICApO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuUE5HLnByb3RvdHlwZS5wYXJzZSA9IGZ1bmN0aW9uIChkYXRhLCBjYWxsYmFjaykge1xuICBpZiAoY2FsbGJhY2spIHtcbiAgICBsZXQgb25QYXJzZWQsIG9uRXJyb3I7XG5cbiAgICBvblBhcnNlZCA9IGZ1bmN0aW9uIChwYXJzZWREYXRhKSB7XG4gICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKFwiZXJyb3JcIiwgb25FcnJvcik7XG5cbiAgICAgIHRoaXMuZGF0YSA9IHBhcnNlZERhdGE7XG4gICAgICBjYWxsYmFjayhudWxsLCB0aGlzKTtcbiAgICB9LmJpbmQodGhpcyk7XG5cbiAgICBvbkVycm9yID0gZnVuY3Rpb24gKGVycikge1xuICAgICAgdGhpcy5yZW1vdmVMaXN0ZW5lcihcInBhcnNlZFwiLCBvblBhcnNlZCk7XG5cbiAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgfS5iaW5kKHRoaXMpO1xuXG4gICAgdGhpcy5vbmNlKFwicGFyc2VkXCIsIG9uUGFyc2VkKTtcbiAgICB0aGlzLm9uY2UoXCJlcnJvclwiLCBvbkVycm9yKTtcbiAgfVxuXG4gIHRoaXMuZW5kKGRhdGEpO1xuICByZXR1cm4gdGhpcztcbn07XG5cblBORy5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9wYXJzZXIud3JpdGUoZGF0YSk7XG4gIHJldHVybiB0cnVlO1xufTtcblxuUE5HLnByb3RvdHlwZS5lbmQgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9wYXJzZXIuZW5kKGRhdGEpO1xufTtcblxuUE5HLnByb3RvdHlwZS5fbWV0YWRhdGEgPSBmdW5jdGlvbiAobWV0YWRhdGEpIHtcbiAgdGhpcy53aWR0aCA9IG1ldGFkYXRhLndpZHRoO1xuICB0aGlzLmhlaWdodCA9IG1ldGFkYXRhLmhlaWdodDtcblxuICB0aGlzLmVtaXQoXCJtZXRhZGF0YVwiLCBtZXRhZGF0YSk7XG59O1xuXG5QTkcucHJvdG90eXBlLl9nYW1tYSA9IGZ1bmN0aW9uIChnYW1tYSkge1xuICB0aGlzLmdhbW1hID0gZ2FtbWE7XG59O1xuXG5QTkcucHJvdG90eXBlLl9oYW5kbGVDbG9zZSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLl9wYXJzZXIud3JpdGFibGUgJiYgIXRoaXMuX3BhY2tlci5yZWFkYWJsZSkge1xuICAgIHRoaXMuZW1pdChcImNsb3NlXCIpO1xuICB9XG59O1xuXG5QTkcuYml0Ymx0ID0gZnVuY3Rpb24gKHNyYywgZHN0LCBzcmNYLCBzcmNZLCB3aWR0aCwgaGVpZ2h0LCBkZWx0YVgsIGRlbHRhWSkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG1heC1wYXJhbXNcbiAgLy8gY29lcmNlIHBpeGVsIGRpbWVuc2lvbnMgdG8gaW50ZWdlcnMgKGFsc28gY29lcmNlcyB1bmRlZmluZWQgLT4gMCk6XG4gIC8qIGVzbGludC1kaXNhYmxlIG5vLXBhcmFtLXJlYXNzaWduICovXG4gIHNyY1ggfD0gMDtcbiAgc3JjWSB8PSAwO1xuICB3aWR0aCB8PSAwO1xuICBoZWlnaHQgfD0gMDtcbiAgZGVsdGFYIHw9IDA7XG4gIGRlbHRhWSB8PSAwO1xuICAvKiBlc2xpbnQtZW5hYmxlIG5vLXBhcmFtLXJlYXNzaWduICovXG5cbiAgaWYgKFxuICAgIHNyY1ggPiBzcmMud2lkdGggfHxcbiAgICBzcmNZID4gc3JjLmhlaWdodCB8fFxuICAgIHNyY1ggKyB3aWR0aCA+IHNyYy53aWR0aCB8fFxuICAgIHNyY1kgKyBoZWlnaHQgPiBzcmMuaGVpZ2h0XG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImJpdGJsdCByZWFkaW5nIG91dHNpZGUgaW1hZ2VcIik7XG4gIH1cblxuICBpZiAoXG4gICAgZGVsdGFYID4gZHN0LndpZHRoIHx8XG4gICAgZGVsdGFZID4gZHN0LmhlaWdodCB8fFxuICAgIGRlbHRhWCArIHdpZHRoID4gZHN0LndpZHRoIHx8XG4gICAgZGVsdGFZICsgaGVpZ2h0ID4gZHN0LmhlaWdodFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJiaXRibHQgd3JpdGluZyBvdXRzaWRlIGltYWdlXCIpO1xuICB9XG5cbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIHNyYy5kYXRhLmNvcHkoXG4gICAgICBkc3QuZGF0YSxcbiAgICAgICgoZGVsdGFZICsgeSkgKiBkc3Qud2lkdGggKyBkZWx0YVgpIDw8IDIsXG4gICAgICAoKHNyY1kgKyB5KSAqIHNyYy53aWR0aCArIHNyY1gpIDw8IDIsXG4gICAgICAoKHNyY1kgKyB5KSAqIHNyYy53aWR0aCArIHNyY1ggKyB3aWR0aCkgPDwgMlxuICAgICk7XG4gIH1cbn07XG5cblBORy5wcm90b3R5cGUuYml0Ymx0ID0gZnVuY3Rpb24gKFxuICBkc3QsXG4gIHNyY1gsXG4gIHNyY1ksXG4gIHdpZHRoLFxuICBoZWlnaHQsXG4gIGRlbHRhWCxcbiAgZGVsdGFZXG4pIHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbGluZSBtYXgtcGFyYW1zXG5cbiAgUE5HLmJpdGJsdCh0aGlzLCBkc3QsIHNyY1gsIHNyY1ksIHdpZHRoLCBoZWlnaHQsIGRlbHRhWCwgZGVsdGFZKTtcbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5QTkcuYWRqdXN0R2FtbWEgPSBmdW5jdGlvbiAoc3JjKSB7XG4gIGlmIChzcmMuZ2FtbWEpIHtcbiAgICBmb3IgKGxldCB5ID0gMDsgeSA8IHNyYy5oZWlnaHQ7IHkrKykge1xuICAgICAgZm9yIChsZXQgeCA9IDA7IHggPCBzcmMud2lkdGg7IHgrKykge1xuICAgICAgICBsZXQgaWR4ID0gKHNyYy53aWR0aCAqIHkgKyB4KSA8PCAyO1xuXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7XG4gICAgICAgICAgbGV0IHNhbXBsZSA9IHNyYy5kYXRhW2lkeCArIGldIC8gMjU1O1xuICAgICAgICAgIHNhbXBsZSA9IE1hdGgucG93KHNhbXBsZSwgMSAvIDIuMiAvIHNyYy5nYW1tYSk7XG4gICAgICAgICAgc3JjLmRhdGFbaWR4ICsgaV0gPSBNYXRoLnJvdW5kKHNhbXBsZSAqIDI1NSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgc3JjLmdhbW1hID0gMDtcbiAgfVxufTtcblxuUE5HLnByb3RvdHlwZS5hZGp1c3RHYW1tYSA9IGZ1bmN0aW9uICgpIHtcbiAgUE5HLmFkanVzdEdhbW1hKHRoaXMpO1xufTtcbiIsICJpbXBvcnQgeyBQTkcgfSBmcm9tICdwbmdqcyc7XG5pbXBvcnQgdHlwZSB7IEZpZ21hTm9kZSwgU3ByaXRlQXNzZXRTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xuaW1wb3J0IHR5cGUgeyBTbGljZUFuYWx5c2lzLCBTbGljZUJvcmRlcnMgfSBmcm9tICcuLi9maWdtYS9zbGljaW5nJztcbmltcG9ydCB0eXBlIHsgQXNzZXRXcml0ZXIgfSBmcm9tICcuL2Fzc2V0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2xpY2VPcHRpbWl6YXRpb24ge1xuICAgIHN0YXR1czogJ2NvbXBhY3RlZCcgfCAndW5jaGFuZ2VkJyB8ICdza2lwcGVkJyB8ICdyZXN0b3JlZCc7XG4gICAgcmVhc29uOiBzdHJpbmc7XG4gICAgc291cmNlV2lkdGg/OiBudW1iZXI7XG4gICAgc291cmNlSGVpZ2h0PzogbnVtYmVyO1xuICAgIHdpZHRoPzogbnVtYmVyO1xuICAgIGhlaWdodD86IG51bWJlcjtcbiAgICBzb3VyY2VCeXRlczogbnVtYmVyO1xuICAgIGJ5dGVzOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGFjdFNsaWNlUmVzdWx0IHtcbiAgICBjb250ZW50czogQnVmZmVyO1xuICAgIGJvcmRlcnM6IFNsaWNlQm9yZGVycztcbiAgICBvcHRpbWl6YXRpb246IFNsaWNlT3B0aW1pemF0aW9uO1xufVxuXG5pbnRlcmZhY2UgU2VnbWVudCB7IHN0YXJ0OiBudW1iZXI7IHNpemU6IG51bWJlcjsgfVxuY29uc3QgU0lHTkFUVVJFID0gQnVmZmVyLmZyb20oWzEzNywgODAsIDc4LCA3MSwgMTMsIDEwLCAyNiwgMTBdKTtcbmNvbnN0IE1BWF9QSVhFTFMgPSAxNiAqIDEwMjQgKiAxMDI0O1xuY29uc3QgTUFYX0JZVEVTID0gNjQgKiAxMDI0ICogMTAyNDtcbmNvbnN0IENPTE9SX0NIVU5LUyA9IG5ldyBTZXQoWydnQU1BJywgJ2NIUk0nLCAnc1JHQicsICdpQ0NQJywgJ3BIWXMnXSk7XG5cbi8qKiBWYWxpZGF0ZSBzaXplIGJlZm9yZSBkZWNvZGluZyBhbmQgcHJlc2VydmUgdGhlIG9yaWdpbmFsIGNvbG9yIGludGVycHJldGF0aW9uLiAqL1xuZnVuY3Rpb24gaW5zcGVjdFBuZyhjb250ZW50czogQnVmZmVyKTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgbWV0YWRhdGE6IEJ1ZmZlcltdIH0ge1xuICAgIGlmIChjb250ZW50cy5sZW5ndGggPCA0NSB8fCBjb250ZW50cy5sZW5ndGggPiBNQVhfQllURVMgfHwgIWNvbnRlbnRzLnN1YmFycmF5KDAsIDgpLmVxdWFscyhTSUdOQVRVUkUpXG4gICAgICAgIHx8IGNvbnRlbnRzLnJlYWRVSW50MzJCRSg4KSAhPT0gMTMgfHwgY29udGVudHMudG9TdHJpbmcoJ2FzY2lpJywgMTIsIDE2KSAhPT0gJ0lIRFInKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignUE5HIFx1NjgzQ1x1NUYwRlx1NjVFMFx1NjU0OFx1NjIxNlx1NjU4N1x1NEVGNlx1OEZDN1x1NTkyN1x1RkYwQ1x1NEZERFx1NzU1OVx1NUI4Q1x1NjU3NFx1NTZGRVx1NzI0NycpO1xuICAgIH1cbiAgICBjb25zdCB3aWR0aCA9IGNvbnRlbnRzLnJlYWRVSW50MzJCRSgxNik7XG4gICAgY29uc3QgaGVpZ2h0ID0gY29udGVudHMucmVhZFVJbnQzMkJFKDIwKTtcbiAgICBpZiAoIXdpZHRoIHx8ICFoZWlnaHQgfHwgd2lkdGggKiBoZWlnaHQgPiBNQVhfUElYRUxTKSB0aHJvdyBuZXcgRXJyb3IoJ1x1NTZGRVx1NzI0N1x1OEQ4NVx1OEZDN1x1NUI4OVx1NTE2OFx1NTkwNFx1NzQwNlx1NTBDRlx1N0QyMFx1NEUwQVx1OTY1MFx1RkYwQ1x1NEZERFx1NzU1OVx1NUI4Q1x1NjU3NFx1NTZGRVx1NzI0NycpO1xuICAgIGlmIChjb250ZW50c1syNF0gPiA4KSB0aHJvdyBuZXcgRXJyb3IoJ1x1OUFEOFx1NEY0RFx1NkRGMSBQTkcgXHU0RTBEXHU4RkRCXHU4ODRDXHU5NjREXHU3Q0JFXHU1RUE2XHU1OTA0XHU3NDA2Jyk7XG4gICAgY29uc3QgbWV0YWRhdGE6IEJ1ZmZlcltdID0gW107XG4gICAgbGV0IGVuZGVkID0gZmFsc2U7XG4gICAgZm9yIChsZXQgb2Zmc2V0ID0gODsgb2Zmc2V0IDwgY29udGVudHMubGVuZ3RoOykge1xuICAgICAgICBpZiAob2Zmc2V0ICsgMTIgPiBjb250ZW50cy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcignUE5HIFx1NjU3MFx1NjM2RVx1NEUwRFx1NUI4Q1x1NjU3NCcpO1xuICAgICAgICBjb25zdCBlbmQgPSBvZmZzZXQgKyAxMiArIGNvbnRlbnRzLnJlYWRVSW50MzJCRShvZmZzZXQpO1xuICAgICAgICBpZiAoZW5kID4gY29udGVudHMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ1BORyBcdTY1NzBcdTYzNkVcdTRFMERcdTVCOENcdTY1NzQnKTtcbiAgICAgICAgY29uc3Qga2luZCA9IGNvbnRlbnRzLnRvU3RyaW5nKCdhc2NpaScsIG9mZnNldCArIDQsIG9mZnNldCArIDgpO1xuICAgICAgICBpZiAoWydhY1RMJywgJ2ZjVEwnLCAnZmRBVCcsICdzQklUJ10uaW5jbHVkZXMoa2luZCkpIHRocm93IG5ldyBFcnJvcignXHU3Mjc5XHU2QjhBIFBORyBcdTUxNDNcdTY1NzBcdTYzNkVcdTY2ODJcdTRFMERcdTY1MkZcdTYzMDFcdTY3MDBcdTVDMEZcdTUzMTYnKTtcbiAgICAgICAgaWYgKENPTE9SX0NIVU5LUy5oYXMoa2luZCkpIG1ldGFkYXRhLnB1c2goY29udGVudHMuc3ViYXJyYXkob2Zmc2V0LCBlbmQpKTtcbiAgICAgICAgb2Zmc2V0ID0gZW5kO1xuICAgICAgICBpZiAoa2luZCA9PT0gJ0lFTkQnKSB7IGVuZGVkID0gdHJ1ZTsgYnJlYWs7IH1cbiAgICB9XG4gICAgaWYgKCFlbmRlZCkgdGhyb3cgbmV3IEVycm9yKCdQTkcgXHU2NTcwXHU2MzZFXHU0RTBEXHU1QjhDXHU2NTc0Jyk7XG4gICAgcmV0dXJuIHsgd2lkdGgsIGhlaWdodCwgbWV0YWRhdGEgfTtcbn1cblxuZnVuY3Rpb24gYXhpc0FsaWduZWQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XG4gICAgY29uc3Qgcm90YXRpb24gPSBub2RlLnJvdGF0aW9uID8/IDA7XG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocm90YXRpb24pIHx8IE1hdGguYWJzKHJvdGF0aW9uKSA+IDAuMDEpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBtYXRyaXggPSBub2RlLnJlbGF0aXZlVHJhbnNmb3JtO1xuICAgIHJldHVybiAhbWF0cml4IHx8IChtYXRyaXgubGVuZ3RoID49IDIgJiYgbWF0cml4WzBdLmxlbmd0aCA+PSAyICYmIG1hdHJpeFsxXS5sZW5ndGggPj0gMlxuICAgICAgICAmJiBbbWF0cml4WzBdWzBdLCBtYXRyaXhbMF1bMV0sIG1hdHJpeFsxXVswXSwgbWF0cml4WzFdWzFdXS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpXG4gICAgICAgICYmIG1hdHJpeFswXVswXSA+IDAgJiYgbWF0cml4WzFdWzFdID4gMFxuICAgICAgICAmJiBNYXRoLmFicyhtYXRyaXhbMF1bMV0pIDw9IDAuMDAwMDAxICYmIE1hdGguYWJzKG1hdHJpeFsxXVswXSkgPD0gMC4wMDAwMDEpO1xufVxuXG4vKiogQWxsIFJHQkEgc2FtcGxlcyBtdXN0IG1hdGNoIGFsb25nIHRoZSBzdHJldGNoIGF4aXMsIGluY2x1ZGluZyBib3RoIGVkZ2UgYmFuZHMuXG4gKiBObyB0b2xlcmFuY2U6IHByZXNlcnZlIHN1YnRsZSBncmFkaWVudHMsIGFscGhhIGZyaW5nZXMsIHRleHQgYW5kIHRleHR1cmUgZGV0YWlsLlxuICovXG5mdW5jdGlvbiByZXBlYXRlZEJhbmQoaW1hZ2U6IFBORywgc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIsIGhvcml6b250YWw6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgICBjb25zdCBzdHJpZGUgPSBpbWFnZS53aWR0aCAqIDQ7XG4gICAgaWYgKCFob3Jpem9udGFsKSB7XG4gICAgICAgIGNvbnN0IGZpcnN0ID0gaW1hZ2UuZGF0YS5zdWJhcnJheShzdGFydCAqIHN0cmlkZSwgKHN0YXJ0ICsgMSkgKiBzdHJpZGUpO1xuICAgICAgICBmb3IgKGxldCB5ID0gc3RhcnQgKyAxOyB5IDwgZW5kOyB5KyspIHtcbiAgICAgICAgICAgIGlmICghZmlyc3QuZXF1YWxzKGltYWdlLmRhdGEuc3ViYXJyYXkoeSAqIHN0cmlkZSwgKHkgKyAxKSAqIHN0cmlkZSkpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgICBmb3IgKGxldCB5ID0gMDsgeSA8IGltYWdlLmhlaWdodDsgeSsrKSB7XG4gICAgICAgICAgICBjb25zdCBmaXJzdCA9IGltYWdlLmRhdGEucmVhZFVJbnQzMkxFKHkgKiBzdHJpZGUgKyBzdGFydCAqIDQpO1xuICAgICAgICAgICAgZm9yIChsZXQgeCA9IHN0YXJ0ICsgMTsgeCA8IGVuZDsgeCsrKSB7XG4gICAgICAgICAgICAgICAgaWYgKGltYWdlLmRhdGEucmVhZFVJbnQzMkxFKHkgKiBzdHJpZGUgKyB4ICogNCkgIT09IGZpcnN0KSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHNlZ21lbnRzKGxlbmd0aDogbnVtYmVyLCBiZWZvcmU6IG51bWJlciwgYWZ0ZXI6IG51bWJlciwga2VlcDogbnVtYmVyLCBzaHJpbms6IGJvb2xlYW4pOiBTZWdtZW50W10ge1xuICAgIGlmICghc2hyaW5rKSByZXR1cm4gW3sgc3RhcnQ6IDAsIHNpemU6IGxlbmd0aCB9XTtcbiAgICByZXR1cm4gW1xuICAgICAgICB7IHN0YXJ0OiAwLCBzaXplOiBiZWZvcmUgfSxcbiAgICAgICAgeyBzdGFydDogYmVmb3JlICsgTWF0aC5mbG9vcigobGVuZ3RoIC0gYmVmb3JlIC0gYWZ0ZXIgLSBrZWVwKSAvIDIpLCBzaXplOiBrZWVwIH0sXG4gICAgICAgIHsgc3RhcnQ6IGxlbmd0aCAtIGFmdGVyLCBzaXplOiBhZnRlciB9LFxuICAgIF07XG59XG5cbi8qKiBBZGFwdGVkIGZyb20gbWFpbi9hNDJmY2M3LiBTaHJpbmsgb25seSBwcm92YWJseSByZXBlYXRhYmxlIG1pZGRsZSBiYW5kcy5cbiAqIEFuYWx5c2lzIHVzZXMgRmlnbWEgbG9naWNhbCB1bml0czsgbWV0YWRhdGEgYW5kIFBORyB1c2UgZXhwb3J0IHBpeGVscy5cbiAqIFRoZSBub2RlIGdlb21ldHJ5LCBpbnB1dCBCdWZmZXIsIHNvdXJjZSBhc3NldCBhbmQgZG93bmxvYWQgY2FjaGUgbmV2ZXIgY2hhbmdlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tcGFjdFNsaWNlUG5nKGNvbnRlbnRzOiBCdWZmZXIsIG5vZGU6IEZpZ21hTm9kZSwgYW5hbHlzaXM6IFNsaWNlQW5hbHlzaXMsIHNjYWxlOiBudW1iZXIpOiBDb21wYWN0U2xpY2VSZXN1bHQge1xuICAgIGNvbnN0IGJvcmRlcnMgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoYW5hbHlzaXMuYm9yZGVycylcbiAgICAgICAgLm1hcCgoW2tleSwgdmFsdWVdKSA9PiBba2V5LCBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKHZhbHVlICogc2NhbGUpKV0pKSBhcyB1bmtub3duIGFzIFNsaWNlQm9yZGVycztcbiAgICBjb25zdCBvcHRpbWl6YXRpb246IFNsaWNlT3B0aW1pemF0aW9uID0ge1xuICAgICAgICBzdGF0dXM6ICdza2lwcGVkJywgcmVhc29uOiAnJywgc291cmNlQnl0ZXM6IGNvbnRlbnRzLmxlbmd0aCwgYnl0ZXM6IGNvbnRlbnRzLmxlbmd0aCxcbiAgICB9O1xuICAgIGNvbnN0IHVuY2hhbmdlZCA9IChyZWFzb246IHN0cmluZywgc3RhdHVzOiAnc2tpcHBlZCcgfCAndW5jaGFuZ2VkJyA9ICdza2lwcGVkJyk6IENvbXBhY3RTbGljZVJlc3VsdCA9PiAoe1xuICAgICAgICBjb250ZW50cywgYm9yZGVycywgb3B0aW1pemF0aW9uOiB7IC4uLm9wdGltaXphdGlvbiwgc3RhdHVzLCByZWFzb24gfSxcbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzY2FsZSkgfHwgc2NhbGUgPD0gMCB8fCAhYXhpc0FsaWduZWQobm9kZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmNoYW5nZWQoJ1x1NjVDQlx1OEY2Q1x1MzAwMVx1N0ZGQlx1OEY2Q1x1NjIxNlx1NjVFMFx1NjU0OFx1NTAwRFx1NzM4N1x1NzY4NFx1NTIwN1x1NzI0N1x1NEZERFx1NzU1OVx1NUI4Q1x1NjU3NFx1NTZGRVx1NzI0NycpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xuICAgICAgICBjb25zdCBoZWFkZXIgPSBpbnNwZWN0UG5nKGNvbnRlbnRzKTtcbiAgICAgICAgT2JqZWN0LmFzc2lnbihvcHRpbWl6YXRpb24sIHsgc291cmNlV2lkdGg6IGhlYWRlci53aWR0aCwgc291cmNlSGVpZ2h0OiBoZWFkZXIuaGVpZ2h0LFxuICAgICAgICAgICAgd2lkdGg6IGhlYWRlci53aWR0aCwgaGVpZ2h0OiBoZWFkZXIuaGVpZ2h0IH0pO1xuICAgICAgICAvLyBTbGljZWQgZXhwb3J0cyB1c2UgdGhlIGdlb21ldHJpYyBjYW52YXMgaW4gVjIuIERvIG5vdCBndWVzcyBhIG5ld1xuICAgICAgICAvLyBjb29yZGluYXRlIHNwYWNlIGZvciBhIGRpZmZlcmVudC1zaXplZCBsb2NhbC9hbHJlYWR5LWNvbXBhY3RlZCBpbWFnZS5cbiAgICAgICAgaWYgKCFmcmFtZSB8fCAhTnVtYmVyLmlzRmluaXRlKGZyYW1lLndpZHRoKSB8fCAhTnVtYmVyLmlzRmluaXRlKGZyYW1lLmhlaWdodClcbiAgICAgICAgICAgIHx8IGZyYW1lLndpZHRoIDw9IDAgfHwgZnJhbWUuaGVpZ2h0IDw9IDBcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKGhlYWRlci53aWR0aCAtIGZyYW1lLndpZHRoICogc2NhbGUpID4gMVxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoaGVhZGVyLmhlaWdodCAtIGZyYW1lLmhlaWdodCAqIHNjYWxlKSA+IDEpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmNoYW5nZWQoJ1x1NTZGRVx1NzI0N1x1NUMzQVx1NUJGOFx1NEUwRVx1NTIwN1x1NzI0N1x1NzUzQlx1NUUwM1x1NEUwRFx1NTMzOVx1OTE0RFx1RkYwQ1x1NEZERFx1NzU1OVx1NUI4Q1x1NjU3NFx1NTZGRVx1NzI0NycpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGhvcml6b250YWwgPSBhbmFseXNpcy5tb2RlICE9PSAndmVydGljYWwnO1xuICAgICAgICBjb25zdCB2ZXJ0aWNhbCA9IGFuYWx5c2lzLm1vZGUgIT09ICdob3Jpem9udGFsJztcbiAgICAgICAgaWYgKCFbJ2hvcml6b250YWwnLCAndmVydGljYWwnLCAnbmluZSddLmluY2x1ZGVzKGFuYWx5c2lzLm1vZGUpXG4gICAgICAgICAgICB8fCBPYmplY3QudmFsdWVzKGFuYWx5c2lzLmJvcmRlcnMpLnNvbWUoKHZhbHVlKSA9PiAhTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8IDApXG4gICAgICAgICAgICB8fCAoaG9yaXpvbnRhbCAmJiAoYm9yZGVycy5sZWZ0IDw9IDAgfHwgYm9yZGVycy5yaWdodCA8PSAwIHx8IGJvcmRlcnMubGVmdCArIGJvcmRlcnMucmlnaHQgPj0gaGVhZGVyLndpZHRoKSlcbiAgICAgICAgICAgIHx8ICh2ZXJ0aWNhbCAmJiAoYm9yZGVycy50b3AgPD0gMCB8fCBib3JkZXJzLmJvdHRvbSA8PSAwIHx8IGJvcmRlcnMudG9wICsgYm9yZGVycy5ib3R0b20gPj0gaGVhZGVyLmhlaWdodCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5jaGFuZ2VkKCdcdTUyMDdcdTcyNDdcdTUwQ0ZcdTdEMjBcdThGQjlcdTc1NENcdTY1RTBcdTY1NDhcdUZGMENcdTRGRERcdTc1NTlcdTVCOENcdTY1NzRcdTU2RkVcdTcyNDcnKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBrZWVwID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZCgyICogc2NhbGUpKTtcbiAgICAgICAgY29uc3QgY2FuU2hyaW5rWCA9IGhvcml6b250YWwgJiYgaGVhZGVyLndpZHRoIC0gYm9yZGVycy5sZWZ0IC0gYm9yZGVycy5yaWdodCA+IGtlZXA7XG4gICAgICAgIGNvbnN0IGNhblNocmlua1kgPSB2ZXJ0aWNhbCAmJiBoZWFkZXIuaGVpZ2h0IC0gYm9yZGVycy50b3AgLSBib3JkZXJzLmJvdHRvbSA+IGtlZXA7XG4gICAgICAgIGlmICghY2FuU2hyaW5rWCAmJiAhY2FuU2hyaW5rWSkgcmV0dXJuIHVuY2hhbmdlZCgnXHU0RTJEXHU1RkMzXHU1MzNBXHU1N0RGXHU1REYyXHU4REIzXHU1OTFGXHU1QzBGJywgJ3VuY2hhbmdlZCcpO1xuICAgICAgICBjb25zdCBpbWFnZSA9IFBORy5zeW5jLnJlYWQoY29udGVudHMsIHsgY2hlY2tDUkM6IHRydWUgfSk7XG4gICAgICAgIGNvbnN0IHNocmlua1ggPSBjYW5TaHJpbmtYICYmIHJlcGVhdGVkQmFuZChpbWFnZSwgYm9yZGVycy5sZWZ0LCBpbWFnZS53aWR0aCAtIGJvcmRlcnMucmlnaHQsIHRydWUpO1xuICAgICAgICBjb25zdCBzaHJpbmtZID0gY2FuU2hyaW5rWSAmJiByZXBlYXRlZEJhbmQoaW1hZ2UsIGJvcmRlcnMudG9wLCBpbWFnZS5oZWlnaHQgLSBib3JkZXJzLmJvdHRvbSwgZmFsc2UpO1xuICAgICAgICBpZiAoIXNocmlua1ggJiYgIXNocmlua1kpIHJldHVybiB1bmNoYW5nZWQoJ1x1NEUyRFx1NUZDM1x1NjIxNlx1OEZCOVx1NUUyNlx1NTQyQlx1OTc1RVx1OTFDRFx1NTkwRFx1NTBDRlx1N0QyMFx1RkYwQ1x1NEUzQVx1NEZERFx1NzU1OVx1NTZGRVx1Njg0OC9cdTZFMTBcdTUzRDhcdTRFMERcdTdGMjlcdTVDMEYnLCAndW5jaGFuZ2VkJyk7XG4gICAgICAgIGNvbnN0IGNvbHVtbnMgPSBzZWdtZW50cyhpbWFnZS53aWR0aCwgYm9yZGVycy5sZWZ0LCBib3JkZXJzLnJpZ2h0LCBrZWVwLCBzaHJpbmtYKTtcbiAgICAgICAgY29uc3Qgcm93cyA9IHNlZ21lbnRzKGltYWdlLmhlaWdodCwgYm9yZGVycy50b3AsIGJvcmRlcnMuYm90dG9tLCBrZWVwLCBzaHJpbmtZKTtcbiAgICAgICAgY29uc3Qgb3V0cHV0ID0gbmV3IFBORyh7IHdpZHRoOiBjb2x1bW5zLnJlZHVjZSgoc3VtLCBpdGVtKSA9PiBzdW0gKyBpdGVtLnNpemUsIDApLFxuICAgICAgICAgICAgaGVpZ2h0OiByb3dzLnJlZHVjZSgoc3VtLCBpdGVtKSA9PiBzdW0gKyBpdGVtLnNpemUsIDApIH0pO1xuICAgICAgICBsZXQgdGFyZ2V0WSA9IDA7XG4gICAgICAgIGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIHtcbiAgICAgICAgICAgIGxldCB0YXJnZXRYID0gMDtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY29sdW1uIG9mIGNvbHVtbnMpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGxldCB5ID0gMDsgeSA8IHJvdy5zaXplOyB5KyspIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb2Zmc2V0ID0gKChyb3cuc3RhcnQgKyB5KSAqIGltYWdlLndpZHRoICsgY29sdW1uLnN0YXJ0KSAqIDQ7XG4gICAgICAgICAgICAgICAgICAgIGltYWdlLmRhdGEuY29weShvdXRwdXQuZGF0YSwgKCh0YXJnZXRZICsgeSkgKiBvdXRwdXQud2lkdGggKyB0YXJnZXRYKSAqIDQsXG4gICAgICAgICAgICAgICAgICAgICAgICBvZmZzZXQsIG9mZnNldCArIGNvbHVtbi5zaXplICogNCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRhcmdldFggKz0gY29sdW1uLnNpemU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0YXJnZXRZICs9IHJvdy5zaXplO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGVuY29kZWQgPSBQTkcuc3luYy53cml0ZShvdXRwdXQpO1xuICAgICAgICBjb25zdCByZXN1bHQgPSBoZWFkZXIubWV0YWRhdGEubGVuZ3RoXG4gICAgICAgICAgICA/IEJ1ZmZlci5jb25jYXQoW2VuY29kZWQuc3ViYXJyYXkoMCwgMzMpLCAuLi5oZWFkZXIubWV0YWRhdGEsIGVuY29kZWQuc3ViYXJyYXkoMzMpXSkgOiBlbmNvZGVkO1xuICAgICAgICByZXR1cm4geyBjb250ZW50czogcmVzdWx0LCBib3JkZXJzLCBvcHRpbWl6YXRpb246IHtcbiAgICAgICAgICAgIC4uLm9wdGltaXphdGlvbiwgc3RhdHVzOiAnY29tcGFjdGVkJyxcbiAgICAgICAgICAgIHJlYXNvbjogc2hyaW5rWCAmJiBzaHJpbmtZID8gJ1x1NkEyQVx1N0VCNVx1NEUyRFx1NUZDM1x1NUUyNlx1NjcwMFx1NUMwRlx1NTMxNicgOiBzaHJpbmtYID8gJ1x1NEVDNVx1NkEyQVx1NTQxMVx1NEUyRFx1NUZDM1x1NUUyNlx1NjcwMFx1NUMwRlx1NTMxNicgOiAnXHU0RUM1XHU3RUI1XHU1NDExXHU0RTJEXHU1RkMzXHU1RTI2XHU2NzAwXHU1QzBGXHU1MzE2JyxcbiAgICAgICAgICAgIHdpZHRoOiBvdXRwdXQud2lkdGgsIGhlaWdodDogb3V0cHV0LmhlaWdodCwgYnl0ZXM6IHJlc3VsdC5sZW5ndGgsXG4gICAgICAgIH0gfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4gdW5jaGFuZ2VkKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ1BORyBcdTY3MDBcdTVDMEZcdTUzMTZcdTU5MzFcdThEMjVcdUZGMENcdTRGRERcdTc1NTlcdTVCOENcdTY1NzRcdTU2RkVcdTcyNDcnKTtcbiAgICB9XG59XG5cbi8qKiBBIGNvbXBhY3QgdGV4dHVyZSBtdXN0IG5ldmVyIGZhbGwgYmFjayB0byBTSU1QTEU6IHJlc3RvcmUgdGhlIGZ1bGwgc291cmNlXG4gKiBmaXJzdCBpZiBDcmVhdG9yIGNhbm5vdCBwZXJzaXN0L3ZlcmlmeSBTTElDRUQgbWV0YWRhdGEuIEJhc2ljIGFzc2V0IElPIGVycm9yc1xuICogc3RpbGwgcHJvcGFnYXRlOyBhIG1pc3NpbmcgZmlsZSBpcyBub3QgYSBzdWNjZXNzZnVsIGltcG9ydC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlU2xpY2VkUG5nKFxuICAgIHdyaXRlcjogUGljazxBc3NldFdyaXRlciwgJ3dyaXRlJz4sIHVybDogc3RyaW5nLCBjb250ZW50czogQnVmZmVyLFxuICAgIG5vZGU6IEZpZ21hTm9kZSwgYW5hbHlzaXM6IFNsaWNlQW5hbHlzaXMsIHNjYWxlOiBudW1iZXIsXG4pOiBQcm9taXNlPHsgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYzsgb3B0aW1pemF0aW9uOiBTbGljZU9wdGltaXphdGlvbiB9PiB7XG4gICAgY29uc3QgY29tcGFjdCA9IGNvbXBhY3RTbGljZVBuZyhjb250ZW50cywgbm9kZSwgYW5hbHlzaXMsIHNjYWxlKTtcbiAgICBsZXQgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYztcbiAgICB0cnkge1xuICAgICAgICBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIGNvbXBhY3QuY29udGVudHMsIGNvbXBhY3QuYm9yZGVycyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgLy8gQXNzZXREQiBtYXkgaGF2ZSBzYXZlZCB0aGUgYnl0ZXMgYmVmb3JlIGEgbGF0ZXIgcmVhZGluZXNzL0lPIGZhaWx1cmUuXG4gICAgICAgIC8vIEJlc3QtZWZmb3J0IHJlc3RvcmUsIGJ1dCBuZXZlciB0dXJuIHRoZSBvcmlnaW5hbCBmYWlsdXJlIGludG8gc3VjY2Vzcy5cbiAgICAgICAgaWYgKGNvbXBhY3Qub3B0aW1pemF0aW9uLnN0YXR1cyA9PT0gJ2NvbXBhY3RlZCcpIHtcbiAgICAgICAgICAgIHRyeSB7IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIGNvbnRlbnRzLCBjb21wYWN0LmJvcmRlcnMpOyB9XG4gICAgICAgICAgICBjYXRjaCAocmVzdG9yZUVycm9yKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcdTRFNURcdTVCQUJcdTVDMEZcdTU2RkVcdTUxOTlcdTUxNjVcdTU5MzFcdThEMjVcdUZGMENcdTVCOENcdTY1NzQgUE5HIFx1NjA2Mlx1NTkwRFx1NEU1Rlx1NTkzMVx1OEQyNVx1RkYxQSR7U3RyaW5nKGVycm9yKX1cdUZGMUIke1N0cmluZyhyZXN0b3JlRXJyb3IpfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgICBpZiAoY29tcGFjdC5vcHRpbWl6YXRpb24uc3RhdHVzID09PSAnY29tcGFjdGVkJyAmJiAoIWFzc2V0LnNsaWNlZCB8fCBhc3NldC5zbGljZUZhbGxiYWNrKSkge1xuICAgICAgICBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIGNvbnRlbnRzLCBjb21wYWN0LmJvcmRlcnMpO1xuICAgICAgICByZXR1cm4geyBhc3NldCwgb3B0aW1pemF0aW9uOiB7IC4uLmNvbXBhY3Qub3B0aW1pemF0aW9uLCBzdGF0dXM6ICdyZXN0b3JlZCcsXG4gICAgICAgICAgICByZWFzb246ICdcdTVDMEZcdTU2RkVcdTRFNURcdTVCQUJcdThGQjlcdThERERcdTY3MkFcdTgwRkRcdTc4NkVcdThCQTRcdUZGMENcdTVERjJcdTYwNjJcdTU5MERcdTVCOENcdTY1NzQgUE5HJyxcbiAgICAgICAgICAgIHdpZHRoOiBjb21wYWN0Lm9wdGltaXphdGlvbi5zb3VyY2VXaWR0aCwgaGVpZ2h0OiBjb21wYWN0Lm9wdGltaXphdGlvbi5zb3VyY2VIZWlnaHQsXG4gICAgICAgICAgICBieXRlczogY29udGVudHMubGVuZ3RoIH0gfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgYXNzZXQsIG9wdGltaXphdGlvbjogY29tcGFjdC5vcHRpbWl6YXRpb24gfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUEsMENBQUFBLFVBQUFDLFNBQUE7QUFBQTtBQUVBLFFBQUksT0FBTyxRQUFRLE1BQU07QUFDekIsUUFBSSxTQUFTLFFBQVEsUUFBUTtBQUU3QixRQUFJLGNBQWVBLFFBQU8sVUFBVSxXQUFZO0FBQzlDLGFBQU8sS0FBSyxJQUFJO0FBRWhCLFdBQUssV0FBVyxDQUFDO0FBQ2pCLFdBQUssWUFBWTtBQUVqQixXQUFLLFNBQVMsQ0FBQztBQUNmLFdBQUssVUFBVTtBQUVmLFdBQUssWUFBWTtBQUNqQixXQUFLLFdBQVc7QUFBQSxJQUNsQjtBQUNBLFNBQUssU0FBUyxhQUFhLE1BQU07QUFFakMsZ0JBQVksVUFBVSxPQUFPLFNBQVUsUUFBUSxVQUFVO0FBQ3ZELFdBQUssT0FBTyxLQUFLO0FBQUEsUUFDZixRQUFRLEtBQUssSUFBSSxNQUFNO0FBQUE7QUFBQSxRQUN2QixXQUFXLFNBQVM7QUFBQSxRQUNwQixNQUFNO0FBQUEsTUFDUixDQUFDO0FBRUQsY0FBUTtBQUFBLFFBQ04sV0FBWTtBQUNWLGVBQUssU0FBUztBQUdk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QU8sTUFBTSxLQUFLLFVBQVUsUUFBUSxPQUFPO0FBQUEsTUFBRyxTQUNuRCxjQUFjO0FBQ2pCLGNBQU0sSUFBSSxNQUFNLDhHQUF5QixPQUFPLEtBQUssQ0FBQyxTQUFJLE9BQU8sWUFBWSxDQUFDLEVBQUU7QUFBQSxNQUNwRjtBQUFBLElBQ0o7QUFDQSxVQUFNO0FBQUEsRUFDVjtBQUNBLE1BQUksUUFBUSxhQUFhLFdBQVcsZ0JBQWdCLENBQUMsTUFBTSxVQUFVLE1BQU0sZ0JBQWdCO0FBQ3ZGLFlBQVEsTUFBTSxPQUFPLE1BQU0sS0FBSyxVQUFVLFFBQVEsT0FBTztBQUN6RCxXQUFPLEVBQUUsT0FBTyxjQUFjO0FBQUEsTUFBRSxHQUFHLFFBQVE7QUFBQSxNQUFjLFFBQVE7QUFBQSxNQUM3RCxRQUFRO0FBQUEsTUFDUixPQUFPLFFBQVEsYUFBYTtBQUFBLE1BQWEsUUFBUSxRQUFRLGFBQWE7QUFBQSxNQUN0RSxPQUFPLFNBQVM7QUFBQSxJQUFPLEVBQUU7QUFBQSxFQUNqQztBQUNBLFNBQU8sRUFBRSxPQUFPLGNBQWMsUUFBUSxhQUFhO0FBQ3ZEOyIsCiAgIm5hbWVzIjogWyJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJpbmZsYXRlZERhdGEiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJleHBvcnRzIiwgIlBORyJdCn0K
