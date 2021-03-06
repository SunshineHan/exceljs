/**
 * Copyright (c) 2015-2017 Guyon Roche
 * LICENCE: MIT - please refer to LICENCE file included with this module
 * or https://github.com/guyonroche/exceljs/blob/master/LICENSE
 */

'use strict';

var fs = require('fs');
var Archiver = require('archiver');
var PromishLib = require('../../utils/promish');

var utils = require('../../utils/utils');
var StreamBuf = require('../../utils/stream-buf');

var RelType = require('../../xlsx/rel-type');
var StylesXform = require('../../xlsx/xform/style/styles-xform');
var SharedStrings = require('../../utils/shared-strings');
var DefinedNames = require('../../doc/defined-names');

var CoreXform = require('../../xlsx/xform/core/core-xform');
var RelationshipsXform = require('../../xlsx/xform/core/relationships-xform');
var ContentTypesXform = require('../../xlsx/xform/core/content-types-xform');
var AppXform = require('../../xlsx/xform/core/app-xform');
var WorkbookXform = require('../../xlsx/xform/book/workbook-xform');
var SharedStringsXform = require('../../xlsx/xform/strings/shared-strings-xform');

var WorksheetWriter = require('./worksheet-writer');

var theme1Xml = require('../../xlsx/xml/theme1.js');

var WorkbookWriter = module.exports = function(options) {
  options = options || {};

  this.created = options.created || new Date();
  this.modified = options.modified || this.created;
  this.creator = options.creator || 'ExcelJS';
  this.lastModifiedBy = options.lastModifiedBy || 'ExcelJS';
  this.lastPrinted = options.lastPrinted;

  // using shared strings creates a smaller xlsx file but may use more memory
  this.useSharedStrings = options.useSharedStrings || false;
  this.sharedStrings = new SharedStrings();

  // style manager
  this.styles = options.useStyles ? new StylesXform(true) : new StylesXform.Mock(true);

  // defined names
  this._definedNames = new DefinedNames();

  this._worksheets = [];
  this.views = [];

  this.zip = Archiver('zip');
  if (options.stream) {
    this.stream = options.stream;
  } else if (options.filename) {
    this.stream = fs.createWriteStream(options.filename);
  } else {
    this.stream = new StreamBuf();
  }
  this.zip.pipe(this.stream);

  // these bits can be added right now
  this.promise = PromishLib.Promish.all([
    this.addThemes(),
    this.addOfficeRels()
  ]);
};

WorkbookWriter.prototype = {
  get definedNames() {
    return this._definedNames;
  },

  _openStream: function(path) {
    var self = this;
    var stream = new StreamBuf({bufSize: 65536, batch: true});
    self.zip.append(stream, { name: path });
    stream.on('finish', function() {
      stream.emit('zipped');
    });
    return stream;
  },
  _commitWorksheets: function() {
    var commitWorksheet = function(worksheet) {
      if (!worksheet.committed) {
        return new PromishLib.Promish(function(resolve) {
          worksheet.stream.on('zipped', function() {
            resolve();
          });
          worksheet.commit();
        });
      }
      return PromishLib.Promish.resolve();
    };
    // if there are any uncommitted worksheets, commit them now and wait
    var promises = this._worksheets.map(commitWorksheet);
    if (promises.length) {
      return PromishLib.Promish.all(promises);
    }
    return PromishLib.Promish.resolve();
  },
  commit: function() {
    // commit all worksheets, then add suplimentary files
    return this.promise.then(() => this._commitWorksheets())
      .then(() => PromishLib.Promish.all([
          this.addContentTypes(),
          this.addApp(),
          this.addCore(),
          this.addSharedStrings(),
          this.addStyles(),
          this.addWorkbookRels()
      ]))
      .then(() => this.addWorkbook())
      .then(() => this._finalize());
  },
  get nextId() {
    // find the next unique spot to add worksheet
    var i;
    for (i = 1; i < this._worksheets.length; i++) {
      if (!this._worksheets[i]) {
        return i;
      }
    }
    return this._worksheets.length || 1;
  },
  addWorksheet: function(name, options) {
    // it's possible to add a worksheet with different than default
    // shared string handling
    // in fact, it's even possible to switch it mid-sheet
    options = options || {};
    var useSharedStrings = options.useSharedStrings !== undefined ?
      options.useSharedStrings :
      this.useSharedStrings;

    if (options.tabColor) {
      console.trace('tabColor option has moved to { properties: tabColor: {...} }');
      options.properties = Object.assign({
        tabColor: options.tabColor
      }, options.properties);
    }

    var id = this.nextId;
    name = name || 'sheet' + id;

    var worksheet = new WorksheetWriter({
      id: id,
      name: name,
      workbook: this,
      useSharedStrings: useSharedStrings,
      properties: options.properties,
      pageSetup: options.pageSetup,
      views: options.views,
      autoFilter: options.autoFilter
    });

    this._worksheets[id] = worksheet;
    return worksheet;
  },
  getWorksheet: function(id) {
    if (id === undefined) {
      return this._worksheets.find(function() { return true; });
    } else if (typeof id === 'number') {
      return this._worksheets[id];
    } else if (typeof id === 'string') {
      return this._worksheets.find(function(worksheet) {
        return worksheet && worksheet.name === id;
      });
    }
    return undefined;
  },
  addStyles: function() {
    var self = this;
    return new PromishLib.Promish(function(resolve) {
      self.zip.append(self.styles.xml, {name: 'xl/styles.xml'});
      resolve();
    });
  },
  addThemes: function() {
    var self = this;
    return new PromishLib.Promish(function(resolve) {
      self.zip.append(theme1Xml, { name: 'xl/theme/theme1.xml' });
      resolve();
    });
  },
  addOfficeRels: function() {
    var self = this;
    return new PromishLib.Promish(function(resolve) {
      var xform = new RelationshipsXform();
      var xml = xform.toXml([
        {rId: 'rId1', type: RelType.OfficeDocument, target: 'xl/workbook.xml'}
      ]);
      self.zip.append(xml, {name: '/_rels/.rels'});
      resolve();
    });
  },

  addContentTypes: function() {
    var self = this;
    return new PromishLib.Promish(function(resolve) {
      var model = {
        worksheets: self._worksheets.filter(Boolean)
      };
      var xform = new ContentTypesXform();
      var xml = xform.toXml(model);
      self.zip.append(xml, {name: '[Content_Types].xml'});
      resolve();
    });
  },
  addApp: function() {
    var self = this;
    return new PromishLib.Promish(function(resolve) {
      var model = {
        worksheets: self._worksheets.filter(Boolean)
      };
      var xform = new AppXform();
      var xml = xform.toXml(model);
      self.zip.append(xml, {name: 'docProps/app.xml'});
      resolve();
    });
  },
  addCore: function() {
    var self = this;
    return new PromishLib.Promish(function(resolve) {
      var coreXform = new CoreXform();
      var xml = coreXform.toXml(self);
      self.zip.append(xml, {name: 'docProps/core.xml'});
      resolve();
    });
  },
  addSharedStrings: function() {
    var self = this;
    if (this.sharedStrings.count) {
      return new PromishLib.Promish(function(resolve) {
        var sharedStringsXform = new SharedStringsXform();
        var xml = sharedStringsXform.toXml(self.sharedStrings);
        self.zip.append(xml, {name: '/xl/sharedStrings.xml'});
        resolve();
      });
    }
    return PromishLib.Promish.resolve();
  },
  addWorkbookRels: function() {
    var self = this;
    var count = 1;
    var relationships = [
      {rId: 'rId' + (count++), type: RelType.Styles, target: 'styles.xml'},
      {rId: 'rId' + (count++), type: RelType.Theme, target: 'theme/theme1.xml'}
    ];
    if (this.sharedStrings.count) {
      relationships.push(
        {rId: 'rId' + (count++), type: RelType.SharedStrings, target: 'sharedStrings.xml'}
      );
    }
    this._worksheets.forEach(function (worksheet) {
      if (worksheet) {
        worksheet.rId = 'rId' + (count++);
        relationships.push(
          {rId: worksheet.rId, type: RelType.Worksheet, target: 'worksheets/sheet' + worksheet.id + '.xml'}
        );
      }
    });
    return new PromishLib.Promish(function(resolve) {
      var xform = new RelationshipsXform();
      var xml = xform.toXml(relationships);
      self.zip.append(xml, {name: '/xl/_rels/workbook.xml.rels'});
      resolve();
    });
  },
  addWorkbook: function() {
    var zip = this.zip;
    var model = {
      worksheets: this._worksheets.filter(Boolean),
      definedNames: this._definedNames.model,
      views: this.views,
      properties: {}
    };

    return new PromishLib.Promish(function(resolve) {
      var xform = new WorkbookXform();
      xform.prepare(model);
      zip.append(xform.toXml(model), {name: '/xl/workbook.xml'});
      resolve();
    });
  },
  _finalize: function() {
    return new PromishLib.Promish((resolve, reject) => {
      this.stream.on('error', reject);
      this.stream.on('finish', () => {
        resolve(this);
      });
      this.zip.on('error', reject);

      this.zip.finalize();
    });
  }
};
