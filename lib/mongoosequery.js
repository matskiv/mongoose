// this is the new Query Object for integrating mquery
// https://github.com/aheckmann/mquery
//


var mquery = require('mquery');
var utils = require('./utils');
var Promise = require('./promise');
var helpers = require('./queryhelpers');
var events = require('events');
var Types = require('./schema/index');
var Document = require('./document');
var QueryStream = require('./querystream');

function MongooseQuery(collection, options, model, conditions) {
  this._mongooseOptions = options || {};

  // create a listener that we will use to deal with commands that need to be
  // buffered because the connection hasn't happened yet
  this.events = new events.EventEmitter();
  this.events.setMaxListeners(0);
  this.mongooseCollection = collection;

  // so this deals with the fact that the connection to the db may not be open
  // at the time of the query run/creation.
  var self = this;
  if(!this.mongooseCollection.conn) {
    throw new Error("The connection doesn't exist, something is wrong");
  }
  this.mongooseCollection.conn.on('open', function() {
    self.collection(self.mongooseCollection.collection);
    self.events.emit('connected', self);
  });

  this.model = model;
  if (this.model && this.model._mapreduce) {
    this.lean();
  }
  // call the mquery constructor
  mquery.call(this, collection.collection, options);
  if (conditions) {
    this.find(conditions);
  }
}

MongooseQuery.prototype = new mquery;

MongooseQuery.base = mquery.prototype;

/**
 * Finds documents.
 *
 * When no `callback` is passed, the query is not executed.
 *
 * ####Example
 *
 *     query.find({ name: 'Los Pollos Hermanos' }).find(callback)
 *
 * @param {Object} [criteria] mongodb selector
 * @param {Function} [callback]
 * @return {Query} this
 * @api public
 */

MongooseQuery.prototype.find = function (conditions, callback) {

  // figure out which conditions are what
  if (conditions instanceof Function) {
    callback = conditions;
    conditions = {};
  }
  if (conditions instanceof Document) {
    conditions = conditions.toObject();
  }
  if (mquery.canMerge(conditions)) {
    this.merge(conditions);
  }

  try {
    this.cast(this.model);
    this._castError = null;
  } catch (err) {
    this._castError = err;
  }

  // if we don't have a callback, then just return the query object
  if (!callback) {
    // pass in an empty array for the conditions here because we already merged
    // them in above when we did the casting
    return MongooseQuery.base.find.call(this, {}, callback);
  } else {
    var promise = new Promise(callback);
    // check for a cast error and return if we have one
    if (this._castError) {
      promise.error(this._castError);
      return this;
    }

    if (!this._collection) {
      this.events.once('connected', function(self) {
        self.find({}, callback);
      });
      return this;
    }

    this._applyPaths();

    this._fields = this._castFields(this._fields);
    MongooseQuery.base.find.call(this, {}, cb);

    var self = this;
    function cb(err, docs) {
      if (err) return promise.error(err);

      if (0 === docs.length) {
        return promise.complete(docs);
      }

      var fields = self._fieldsForExec();
      var options = self._mongooseOptions;

      if (!options.populate) {
        return true === options.lean ? promise.complete(docs) :
          completeMany(self.model, docs, fields, self, null, promise);
      }

      var pop = helpers.preparePopulationOptionsMQ(self, options);
      self.model.populate(docs, pop, function (err, docs) {
        if(err) return promise.error(err);
        return true === options.lean ? promise.complete(docs) :
          completeMany(self.model, docs, fields, self, pop, promise);
      });
    }
  }
}

/*!
 * hydrates many documents
 *
 * @param {Model} model
 * @param {Array} docs
 * @param {Object} fields
 * @param {Query} self
 * @param {Array} [pop] array of paths used in population
 * @param {Promise} promise
 */

function completeMany (model, docs, fields, self, pop, promise) {
  var arr = [];
  var count = docs.length;
  var len = count;
  var opts = pop ?
    { populated: pop }
    : undefined;

  for (var i=0; i < len; ++i) {
    arr[i] = new model(undefined, fields, true);
    arr[i].init(docs[i], opts, function (err) {
      if (err) return promise.error(err);
      --count || promise.complete(arr);
    });
  }
}

/**
 * Sets query options.
 *
 * ####Options:
 *
 * - [tailable](http://www.mongodb.org/display/DOCS/Tailable+Cursors) *
 * - [sort](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7Bsort(\)%7D%7D) *
 * - [limit](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7Blimit%28%29%7D%7D) *
 * - [skip](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7Bskip%28%29%7D%7D) *
 * - [maxscan](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%24maxScan) *
 * - [batchSize](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7BbatchSize%28%29%7D%7D) *
 * - [comment](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%24comment) *
 * - [snapshot](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%7B%7Bsnapshot%28%29%7D%7D) *
 * - [hint](http://www.mongodb.org/display/DOCS/Advanced+Queries#AdvancedQueries-%24hint) *
 * - [slaveOk](http://docs.mongodb.org/manual/applications/replication/#read-preference) *
 * - [lean](./api.html#query_Query-lean) *
 * - [safe](http://www.mongodb.org/display/DOCS/getLastError+Command)
 *
 * _* denotes a query helper method is also available_
 *
 * @param {Object} options
 * @api public
 */

MongooseQuery.prototype.setOptions = function (options, overwrite) {
  // overwrite is only for internal use
  if (overwrite) {
    options = this._mongooseOptions = options || {};

    if('populate' in options) {
      this.populate(this._mongooseOptions);
    }
    return this;
  }

  if (!(options && 'Object' == options.constructor.name)) {
    return this;
  }

  return MongooseQuery.base.setOptions.call(this, options);
}

/**
* Sets the sort order
*
* If an object is passed, values allowed are 'asc', 'desc', 'ascending', 'descending', 1, and -1.
*
* If a string is passed, it must be a space delimited list of path names. The
* sort order of each path is ascending unless the path name is prefixed with `-`
* which will be treated as descending.
*
* ####Example
*
* // these are equivalent
* query.sort({ field: 'asc', test: -1 });
* query.sort('field -test');
*
* ####Note
*
* Cannot be used with `distinct()`
*
* Note: This wrapper is necessary because we have to still deal with the crazy
* [[ "foo", -1]] syntax that is in the driver. ...terrible syntax
*
* @param {Object|String} arg
* @return {Query} this
* @api public
*/

MongooseQuery.prototype.sort = function (arg) {
  var nArg = {};

  if (arguments.length > 1) {
    throw new Error("sort() only takes 1 Argument");
  }

  if (Array.isArray(arg)) {
    // time to deal with the terrible syntax
    nArg[arg[0]] = arg[1];
  } else {
    nArg = arg;
  }
  return MongooseQuery.base.sort.call(this, nArg);
}

/**
 * Returns default options.
 * @param {Model} model
 * @api private
 */

MongooseQuery.prototype._optionsForExec = function (model) {
  var options = MongooseQuery.base._optionsForExec.call(this);

  delete options.populate;

  if (!model) {
    return options;
  } else {
    if (!('safe' in options) && model.schema.options.safe) {
      options.safe = model.schema.options.safe;
    }

    if(!('readPreference' in options) && model.schema.options.read) {
      options.readPreference = model.schema.options.read;
    }

    return options;
  }
};

/**
 * Sets the lean option.
 *
 * Documents returned from queries with the `lean` option enabled are plain javascript objects, not [MongooseDocuments](#document-js). They have no `save` method, getters/setters or other Mongoose magic applied.
 *
 * ####Example:
 *
 *     new Query().lean() // true
 *     new Query().lean(true)
 *     new Query().lean(false)
 *
 *     Model.find().lean().exec(function (err, docs) {
 *       docs[0] instanceof mongoose.Document // false
 *     });
 *
 * This is a [great](https://groups.google.com/forum/#!topic/mongoose-orm/u2_DzDydcnA/discussion) option in high-performance read-only scenarios, especially when combined with [stream](#query_Query-stream).
 *
 * @param {Boolean} bool defaults to true
 * @return {Query} this
 * @api public
 */

MongooseQuery.prototype.lean = function (v) {
  this._mongooseOptions.lean = arguments.length ? !!v : true;
  return this;
}

MongooseQuery.prototype.findOne = function (conditions, fields, options, callback) {

  if ('function' == typeof conditions) {
    callback = conditions;
    conditions = null;
    fields = null;
    options = null;
  }

  if ('function' == typeof fields) {
    callback = fields;
    options = null;
    fields = null;
  }

  if ('function' == typeof options) {
    callback = options;
    options = null;
  }
  // make sure we don't send in the whole Document to merge()
  if (conditions instanceof Document) {
    conditions = conditions.toObject();
  }
  if (options) {
    this.setOptions(options);
  }
  if (fields) {
    this.select(fields);
  }

  if (mquery.canMerge(conditions)) {
    this.merge(conditions);
  }

  try {
    this.cast(this.model);
    this._castError = null;
  } catch (err) {
    this._castError = err;
  }
  if (!callback) {
    // already merged in the conditions, don't need to send them in.
    return MongooseQuery.base.findOne.call(this, {}, callback);
  } else {

    var promise = new Promise(callback);

    if (this._castError) {
      promise.error(this._castError);
      return this;
    }

    var self = this;

    if (!this._collection) {
      this.events.once('connected', function(self) {
        self.findOne({}, fields, options, callback);
      });
      return this;
    }
    this._applyPaths();
    this._fields = this._castFields(this._fields);
    // dont pass in the conditions because we already merged them in
    MongooseQuery.base.findOne.call(this, {}, cb);
    var options = this._mongooseOptions;
    var fields = this._fieldsForExec();

    function cb (err, doc) {
      if (err) return promise.error(err);
      if (!doc) return promise.complete(null);

      if (!options.populate) {
        return true === options.lean ? promise.complete(doc)
          : completeOne(self.model, doc, fields, self, null, promise);
      }

      var pop = helpers.preparePopulationOptionsMQ(self, options);
      self.model.populate(doc, pop, function (err, doc) {
        if (err) return promise.error(err);

        return true === options.lean ? promise.complete(doc)
          : completeOne(self.model, doc, fields, self, pop, promise);
      });
    }

    return this;
  }
}

MongooseQuery.prototype.count = function (conditions, callback) {

  if ('function' == typeof conditions) {
    callback = conditions;
    conditions = undefined;
  }

  if (mquery.canMerge(conditions)) {
    this.merge(conditions);
  }

  try {
    this.cast(this.model);
  } catch (err) {
    callback(err);
    return this;
  }

  if (!this._collection) {
    this.events.once('connected', function(self) {
      self.count({}, callback);
    });
    return this;
  }
  return MongooseQuery.base.count.call(this, {}, callback);
}

MongooseQuery.prototype.distinct = function (conditions, field, callback) {
  if (!this._collection) {
    this.events.once('connected', function(self) {
      self.distinct(conditions, field, callback);
    });
    return this;
  }

  if(!callback) {
    if('function' == typeof field) {
      callback = field;
      if ('string' == typeof conditions) {
        field = conditions;
        conditions = undefined;
      }
    }

    switch (typeof conditions) {
      case 'string':
        field = conditions;
        conditions = undefined;
        break;
      case 'function':
        callback = conditions;
        field = undefined;
        conditions = undefined;
        break;
    }
  }
  if (mquery.canMerge(conditions)) {
    this.merge(conditions)
  }
  try {
    this.cast(this.model);
  } catch (err) {
    callback(err);
    return this;
  }

  return MongooseQuery.base.distinct.call(this, {}, field, callback);
}

MongooseQuery.prototype.remove = function (callback) {
  var cb = 'function' == typeof callback;

  try {
    this.cast(this.model);
  } catch (err) {
    if (cb) return callback(err);
    return this;
  }
  if (!this._collection) {
    this.events.once('connected', function(self) {
      self.remove(callback);
    });
    return this;
  }

  return MongooseQuery.base.remove.call(this, callback);
}

/*!
 * hydrates a document
 *
 * @param {Model} model
 * @param {Document} doc
 * @param {Object} fields
 * @param {Query} self
 * @param {Array} [pop] array of paths used in population
 * @param {Promise} promise
 */

function completeOne (model, doc, fields, self, pop, promise) {
  var opts = pop ?
    { populated: pop }
    : undefined;

  var casted = new model(undefined, fields, true);
  casted.init(doc, opts, function (err) {
    if (err) return promise.error(err);
    promise.complete(casted);
  });
}


/**
 * _findAndModify
 *
 * Could not use the builtin functionality of mquery for this one since there
 * was too much casting going on.
 *
 * @param {String} type - either "remove" or "update"
 * @param {Function} callback
 * @api private
 */

MongooseQuery.prototype._findAndModify = function (type, callback) {
  if (!this._collection) {
    this.events.once('connected', function(self) {
      self._findAndModify(type, callback);
    });
    return this;
  }
  if ('function' != typeof callback) throw new Error("Expected callback in _findAndModify");
  var model = this.model
    , promise = new Promise(callback)
    , self = this
    , castedQuery
    , castedDoc
    , fields
    , opts;

  castedQuery = castQuery(this);
  if (castedQuery instanceof Error) {
    process.nextTick(promise.error.bind(promise, castedQuery));
    return promise;
  }

  opts = this._optionsForExec(model);

  if ('remove' == type) {
    opts.remove = true;
  } else {
    if (!('new' in opts)) opts.new = true;
    if (!('upsert' in opts)) opts.upsert = false;

    castedDoc = castDoc(this);
    if (!castedDoc) {
      if (opts.upsert) {
        // still need to do the upsert to empty doc
        castedDoc = { $set: {} };
      } else {
        return this.findOne(callback);
      }
    } else if (castedDoc instanceof Error) {
      process.nextTick(promise.error.bind(promise, castedDoc));
      return promise;
    }
  }

  this._applyPaths();

  var self = this;
  var options = this._mongooseOptions;

  if (this._fields) {
    fields = utils.clone(this._fields);
    opts.fields = this._castFields(fields);
    if (opts.fields instanceof Error) {
      process.nextTick(promise.error.bind(promise, opts.fields));
      return promise;
    }
  }

  this._collection.findAndModify(castedQuery, castedDoc, opts, utils.tick(cb));

  function cb (err, doc) {
    if (err) throw err;
    if (err) return promise.error(err);

    if (!doc) return promise.complete(null);

    if (!options.populate) {
      return true === options.lean ? promise.complete(doc)
        : completeOne(self.model, doc, fields, self, null, promise);
    }

    var pop = helpers.preparePopulationOptionsMQ(self, options);
    self.model.populate(doc, pop, function (err, doc) {
      if (err) return promise.error(err);

      return true === options.lean ? promise.complete(doc)
        : completeOne(self.model, doc, fields, self, pop, promise);
    });
  }

  return promise;
}

MongooseQuery.prototype.update = function (conditions, doc, options, callback) {
  if ('function' === typeof options) {
    // Scenario: update(conditions, doc, callback)
    callback = options;
    options = null;
  } else if ('function' === typeof doc) {
    // Scenario: update(doc, callback);
    callback = doc;
    doc = conditions;
    conditions = {};
    options = null;
  } else if ('function' === typeof conditions) {
    callback = conditions;
    conditions = undefined;
    doc = undefined;
    options = undefined;
  }
  // make sure we don't send in the whole Document to merge()
  if (conditions instanceof Document) {
    conditions = conditions.toObject();
  }

  // strict is an option used in the update checking, make sure it gets set
  if (options) {
    if ('strict' in options) {
      this._mongooseOptions.strict = options.strict;
    }
  }

  // if doc is undefined at this point, this means this function is being
  // executed by exec(not always see below). Grab the update doc from here in
  // order to validate
  // This could also be somebody calling update() or update({}). Probably not a
  // common use case, check for _update to make sure we don't do anything bad
  if (!doc && this._update) {
    doc = this._updateForExec();
  }

  // validate the selector part of the query
  var castedDoc;
  if (conditions) {
    this._conditions = conditions;
  }
  var castedQuery = castQuery(this);
  if (castedQuery instanceof Error) {
    if(callback) {
      callback(castedQuery);
      return this;
    } else {
      throw castedQuery;
    }
  }
  // validate the update part of the query
  try {
    castedDoc = this._castUpdate(doc);
    if (!castedDoc) {
      callback && callback(null, 0);
      return this;
    }
  } catch (err) {
    if (callback) {
      callback(err);
      return this;
    } else {
      throw err;
    }
  }
  if (!this._collection) {
    this.events.once('connected', function(self) {
      self.update(conditions, doc, options, callback);
    });
    return this;
  }

  return MongooseQuery.base.update.call(this, castedQuery, castedDoc, options, callback);
}

/**
 * Executes the query
 *
 *  This basically just wraps the mquery exec with a promise
 *
 * ####Examples
 *
 * query.exec();
 * query.exec(callback);
 * query.exec('update');
 * query.exec('find', callback);
 *
 * @param {String|Function} [operation]
 * @param {Function} [callback]
 * @return {Promise}
 * @api public
 */

MongooseQuery.prototype.exec = function exec (op, callback) {
  var promise = new Promise();

  if ('function' == typeof op) {
    callback = op;
    op = null;
  } else if ('string' == typeof op) {
    this.op = op;
  }

  if (callback) promise.addBack(callback);

  if (!this.op) {
    promise.complete();
    return promise;
  }

  MongooseQuery.base.exec.call(this, op, promise.resolve.bind(promise));

  return promise;
}

/**
 * Finds the schema for `path`. This is different than
 * calling `schema.path` as it also resolves paths with
 * positional selectors (something.$.another.$.path).
 *
 * @param {String} path
 * @api private
 */

MongooseQuery.prototype._getSchema = function _getSchema (path) {
  return this.model._getSchema(path);
}

/*!
 * These operators require casting docs
 * to real Documents for Update operations.
 */

var castOps = {
    $push: 1
  , $pushAll: 1
  , $addToSet: 1
  , $set: 1
};

/*!
 * These operators should be cast to numbers instead
 * of their path schema type.
 */

var numberOps = {
    $pop: 1
  , $unset: 1
  , $inc: 1
}

/**
 * Casts obj for an update command.
 *
 * @param {Object} obj
 * @return {Object} obj after casting its values
 * @api private
 */

MongooseQuery.prototype._castUpdate = function _castUpdate (obj) {
  if (!obj) return undefined;
  var ops = Object.keys(obj)
    , i = ops.length
    , ret = {}
    , hasKeys
    , val

  while (i--) {
    var op = ops[i];
    if ('$' !== op[0]) {
      // fix up $set sugar
      if (!ret.$set) {
        if (obj.$set) {
          ret.$set = obj.$set;
        } else {
          ret.$set = {};
        }
      }
      ret.$set[op] = obj[op];
      ops.splice(i, 1);
      if (!~ops.indexOf('$set')) ops.push('$set');
    } else if ('$set' === op) {
      if (!ret.$set) {
        ret[op] = obj[op];
      }
    } else {
      ret[op] = obj[op];
    }
  }

  // cast each value
  i = ops.length;

  while (i--) {
    op = ops[i];
    val = ret[op];
    if ('Object' === val.constructor.name) {
      hasKeys |= this._walkUpdatePath(val, op);
    } else {
      var msg = 'Invalid atomic update value for ' + op + '. '
              + 'Expected an object, received ' + typeof val;
      throw new Error(msg);
    }
  }

  return hasKeys && ret;
}

/**
 * Walk each path of obj and cast its values
 * according to its schema.
 *
 * @param {Object} obj - part of a query
 * @param {String} op - the atomic operator ($pull, $set, etc)
 * @param {String} pref - path prefix (internal only)
 * @return {Bool} true if this path has keys to update
 * @api private
 */

MongooseQuery.prototype._walkUpdatePath = function _walkUpdatePath (obj, op, pref) {
  var prefix = pref ? pref + '.' : ''
    , keys = Object.keys(obj)
    , i = keys.length
    , hasKeys = false
    , schema
    , key
    , val

  var strict = 'strict' in this._mongooseOptions
    ? this._mongooseOptions.strict
    : this.model.schema.options.strict;

  while (i--) {
    key = keys[i];
    val = obj[key];

    if (val && 'Object' === val.constructor.name) {
      // watch for embedded doc schemas
      schema = this._getSchema(prefix + key);
      if (schema && schema.caster && op in castOps) {
        // embedded doc schema

        if (strict && !schema) {
          // path is not in our strict schema
          if ('throw' == strict) {
            throw new Error('Field `' + key + '` is not in schema.');
          } else {
            // ignore paths not specified in schema
            delete obj[key];
          }
        } else {
          hasKeys = true;

          if ('$each' in val) {
            obj[key] = {
                $each: this._castUpdateVal(schema, val.$each, op)
            }

            if (val.$slice) {
              obj[key].$slice = val.$slice | 0;
            }

            if (val.$sort) {
              obj[key].$sort = val.$sort;
            }

          } else {
            obj[key] = this._castUpdateVal(schema, val, op);
          }
        }
      } else {
        hasKeys |= this._walkUpdatePath(val, op, prefix + key);
      }
    } else {
      schema = '$each' === key
        ? this._getSchema(pref)
        : this._getSchema(prefix + key);

      var skip = strict &&
                 !schema &&
                 !/real|nested/.test(this.model.schema.pathType(prefix + key));

      if (skip) {
        if ('throw' == strict) {
          throw new Error('Field `' + prefix + key + '` is not in schema.');
        } else {
          delete obj[key];
        }
      } else {
        hasKeys = true;
        obj[key] = this._castUpdateVal(schema, val, op, key);
      }
    }
  }
  return hasKeys;
}

/**
 * Casts `val` according to `schema` and atomic `op`.
 *
 * @param {Schema} schema
 * @param {Object} val
 * @param {String} op - the atomic operator ($pull, $set, etc)
 * @param {String} [$conditional]
 * @api private
 */

MongooseQuery.prototype._castUpdateVal = function _castUpdateVal (schema, val, op, $conditional) {
  if (!schema) {
    // non-existing schema path
    return op in numberOps
      ? Number(val)
      : val
  }

  if (schema.caster && op in castOps &&
    ('Object' === val.constructor.name || Array.isArray(val))) {
    // Cast values for ops that add data to MongoDB.
    // Ensures embedded documents get ObjectIds etc.
    var tmp = schema.cast(val);

    if (Array.isArray(val)) {
      val = tmp;
    } else {
      val = tmp[0];
    }
  }

  if (op in numberOps) return Number(val);
  if (/^\$/.test($conditional)) return schema.castForQuery($conditional, val);
  return schema.castForQuery(val)
}

/*!
 * castQuery
 * @api private
 */

function castQuery (query) {
  try {
    return query.cast(query.model);
  } catch (err) {
    return err;
  }
}

/*!
 * castDoc
 * @api private
 */

function castDoc (query) {
  try {
    return query._castUpdate(query._update);
  } catch (err) {
    return err;
  }
}

/**
 * Specifies paths which should be populated with other documents.
 *
 * ####Example:
 *
 *     Kitten.findOne().populate('owner').exec(function (err, kitten) {
 *       console.log(kitten.owner.name) // Max
 *     })
 *
 *     Kitten.find().populate({
 *         path: 'owner'
 *       , select: 'name'
 *       , match: { color: 'black' }
 *       , options: { sort: { name: -1 }}
 *     }).exec(function (err, kittens) {
 *       console.log(kittens[0].owner.name) // Zoopa
 *     })
 *
 *     // alternatively
 *     Kitten.find().populate('owner', 'name', null, {sort: { name: -1 }}).exec(function (err, kittens) {
 *       console.log(kittens[0].owner.name) // Zoopa
 *     })
 *
 * Paths are populated after the query executes and a response is received. A separate query is then executed for each path specified for population. After a response for each query has also been returned, the results are passed to the callback.
 *
 * @param {Object|String} path either the path to populate or an object specifying all parameters
 * @param {Object|String} [select] Field selection for the population query
 * @param {Model} [model] The name of the model you wish to use for population. If not specified, the name is looked up from the Schema ref.
 * @param {Object} [match] Conditions for the population query
 * @param {Object} [options] Options for the population query (sort, etc)
 * @see population ./populate.html
 * @see Query#select #query_Query-select
 * @see Model.populate #model_Model.populate
 * @return {Query} this
 * @api public
 */

MongooseQuery.prototype.populate = function () {
  var res = utils.populate.apply(null, arguments);
  var opts = this._mongooseOptions;

  if (!utils.isObject(opts.populate)) {
    opts.populate = {};
  }

  for (var i = 0; i < res.length; ++i) {
    opts.populate[res[i].path] = res[i];
  }

  return this;
}

MongooseQuery.prototype.cast = function (model, obj) {
  obj || (obj = this._conditions);

  var schema = model.schema,
      paths = Object.keys(obj),
      i = paths.length,
      any$conditionals,
      schematype,
      nested,
      path,
      type,
      val;

  while (i--) {
    path = paths[i];
    val = obj[path];

    if ('$or' === path || '$nor' === path || '$and' === path) {
      var k = val.length
        , orComponentQuery;

      while (k--) {
        orComponentQuery = new MongooseQuery(this.mongooseCollection, {}, null, val[k]);
        orComponentQuery.cast(model);
        val[k] = orComponentQuery._conditions;
      }

    } else if (path === '$where') {
      type = typeof val;

      if ('string' !== type && 'function' !== type) {
        throw new Error("Must have a string or function for $where");
      }

      if ('function' === type) {
        obj[path] = val.toString();
      }

      continue;

    } else {

      if (!schema) {
        // no casting for Mixed types
        continue;
      }

      schematype = schema.path(path);

      if (!schematype) {
        // Handle potential embedded array queries
        var split = path.split('.')
          , j = split.length
          , pathFirstHalf
          , pathLastHalf
          , remainingConds
          , castingQuery;

        // Find the part of the var path that is a path of the Schema
        while (j--) {
          pathFirstHalf = split.slice(0, j).join('.');
          schematype = schema.path(pathFirstHalf);
          if (schematype) break;
        }

        // If a substring of the input path resolves to an actual real path...
        if (schematype) {
          // Apply the casting; similar code for $elemMatch in schema/array.js
          if (schematype.caster && schematype.caster.schema) {
            remainingConds = {};
            pathLastHalf = split.slice(j).join('.');
            remainingConds[pathLastHalf] = val;
            castingQuery = new MongooseQuery(this.mongooseCollection, {}, null, remainingConds);
            castingQuery.cast(schematype.caster);
            obj[path] = castingQuery._conditions[pathLastHalf];
          } else {
            obj[path] = val;
          }
          continue;
        }

        if (utils.isObject(val)) {
          // handle geo schemas that use object notation
          // { loc: { long: Number, lat: Number }

          var geo = val.$near ? '$near' :
                    val.$nearSphere ? '$nearSphere' :
                    val.$within ? '$within' :
                    val.$geoIntersects ? '$geoIntersects' : '';

          if (!geo) {
            continue;
          }

          var numbertype = new Types.Number('__QueryCasting__')
          var value = val[geo];

          if (val.$maxDistance) {
            val.$maxDistance = numbertype.castForQuery(val.$maxDistance);
          }

          if ('$within' == geo) {
            var withinType = value.$center
                          || value.$centerSphere
                          || value.$box
                          || value.$polygon;

            if (!withinType) {
              throw new Error('Bad $within paramater: ' + JSON.stringify(val));
            }

            value = withinType;

          } else if ('$near' == geo &&
              'string' == typeof value.type && Array.isArray(value.coordinates)) {
            // geojson; cast the coordinates
            value = value.coordinates;

          } else if (('$near' == geo || '$geoIntersects' == geo) &&
              value.$geometry && 'string' == typeof value.$geometry.type &&
              Array.isArray(value.$geometry.coordinates)) {
            // geojson; cast the coordinates
            value = value.$geometry.coordinates;
          }

          ;(function _cast (val) {
            if (Array.isArray(val)) {
              val.forEach(function (item, i) {
                if (Array.isArray(item) || utils.isObject(item)) {
                  return _cast(item);
                }
                val[i] = numbertype.castForQuery(item);
              });
            } else {
              var nearKeys= Object.keys(val);
              var nearLen = nearKeys.length;
              while (nearLen--) {
                var nkey = nearKeys[nearLen];
                var item = val[nkey];
                if (Array.isArray(item) || utils.isObject(item)) {
                  _cast(item);
                  val[nkey] = item;
                } else {
                  val[nkey] = numbertype.castForQuery(item);
                }
              }
            }
          })(value);
        }

      } else if (val === null || val === undefined) {
        continue;
      } else if ('Object' === val.constructor.name) {

        any$conditionals = Object.keys(val).some(function (k) {
          return k.charAt(0) === '$' && k !== '$id' && k !== '$ref';
        });

        if (!any$conditionals) {
          obj[path] = schematype.castForQuery(val);
        } else {

          var ks = Object.keys(val)
            , k = ks.length
            , $cond;

          while (k--) {
            $cond = ks[k];
            nested = val[$cond];

            if ('$exists' === $cond) {
              if ('boolean' !== typeof nested) {
                throw new Error("$exists parameter must be Boolean");
              }
              continue;
            }

            if ('$type' === $cond) {
              if ('number' !== typeof nested) {
                throw new Error("$type parameter must be Number");
              }
              continue;
            }

            if ('$not' === $cond) {
              this.cast(model, nested);
            } else {
              val[$cond] = schematype.castForQuery($cond, nested);
            }
          }
        }
      } else {
        obj[path] = schematype.castForQuery(val);
      }
    }
  }

  return obj;
}

/**
 * Casts selected field arguments for field selection with mongo 2.2
 *
 *     query.select({ ids: { $elemMatch: { $in: [hexString] }})
 *
 * @param {Object} fields
 * @see https://github.com/LearnBoost/mongoose/issues/1091
 * @see http://docs.mongodb.org/manual/reference/projection/elemMatch/
 * @api private
 */

MongooseQuery.prototype._castFields = function _castFields (fields) {
  var selected
    , elemMatchKeys
    , keys
    , key
    , out
    , i

  if (fields) {
    keys = Object.keys(fields);
    elemMatchKeys = [];
    i = keys.length;

    // collect $elemMatch args
    while (i--) {
      key = keys[i];
      if (fields[key].$elemMatch) {
        selected || (selected = {});
        selected[key] = fields[key];
        elemMatchKeys.push(key);
      }
    }
  }

  if (selected) {
    // they passed $elemMatch, cast em
    try {
      out = this.cast(this.model, selected);
    } catch (err) {
      return err;
    }

    // apply the casted field args
    i = elemMatchKeys.length;
    while (i--) {
      key = elemMatchKeys[i];
      fields[key] = out[key];
    }
  }

  return fields;
}

/**
 * Applies schematype selected options to this query.
 * @api private
 */

MongooseQuery.prototype._applyPaths = function applyPaths () {
  // determine if query is selecting or excluding fields

  var fields = this._fields
    , exclude
    , keys
    , ki

  if (fields) {
    keys = Object.keys(fields);
    ki = keys.length;

    while (ki--) {
      if ('+' == keys[ki][0]) continue;
      exclude = 0 === fields[keys[ki]];
      break;
    }
  }

  // if selecting, apply default schematype select:true fields
  // if excluding, apply schematype select:false fields

  var selected = []
    , excluded = []
    , seen = [];

  analyzeSchema(this.model.schema);

  switch (exclude) {
    case true:
      excluded.length && this.select('-' + excluded.join(' -'));
      break;
    case false:
      selected.length && this.select(selected.join(' '));
      break;
    case undefined:
      // user didn't specify fields, implies returning all fields.
      // only need to apply excluded fields
      excluded.length && this.select('-' + excluded.join(' -'));
      break;
  }

  return seen = excluded = selected = keys = fields = null;

  function analyzeSchema (schema, prefix) {
    prefix || (prefix = '');

    // avoid recursion
    if (~seen.indexOf(schema)) return;
    seen.push(schema);

    schema.eachPath(function (path, type) {
      if (prefix) path = prefix + '.' + path;

      analyzePath(path, type);

      // array of subdocs?
      if (type.schema) {
        analyzeSchema(type.schema, path);
      }

    });
  }

  function analyzePath (path, type) {
    if ('boolean' != typeof type.selected) return;

    var plusPath = '+' + path;
    if (fields && plusPath in fields) {
      // forced inclusion
      delete fields[plusPath];

      // if there are other fields being included, add this one
      // if no other included fields, leave this out (implied inclusion)
      if (false === exclude && keys.length > 1 && !~keys.indexOf(path)) {
        fields[path] = 1;
      }

      return
    };

    // check for parent exclusions
    var root = path.split('.')[0];
    if (~excluded.indexOf(root)) return;

    ;(type.selected ? selected : excluded).push(path);
  }
}

/**
 * Casts selected field arguments for field selection with mongo 2.2
 *
 *     query.select({ ids: { $elemMatch: { $in: [hexString] }})
 *
 * @param {Object} fields
 * @see https://github.com/LearnBoost/mongoose/issues/1091
 * @see http://docs.mongodb.org/manual/reference/projection/elemMatch/
 * @api private
 */

MongooseQuery.prototype._castFields = function _castFields (fields) {
  var selected
    , elemMatchKeys
    , keys
    , key
    , out
    , i

  if (fields) {
    keys = Object.keys(fields);
    elemMatchKeys = [];
    i = keys.length;

    // collect $elemMatch args
    while (i--) {
      key = keys[i];
      if (fields[key].$elemMatch) {
        selected || (selected = {});
        selected[key] = fields[key];
        elemMatchKeys.push(key);
      }
    }
  }

  if (selected) {
    // they passed $elemMatch, cast em
    try {
      out = this.cast(this.model, selected);
    } catch (err) {
      return err;
    }

    // apply the casted field args
    i = elemMatchKeys.length;
    while (i--) {
      key = elemMatchKeys[i];
      fields[key] = out[key];
    }
  }

  return fields;
}

/**
 * Returns a Node.js 0.8 style [read stream](http://nodejs.org/docs/v0.8.21/api/stream.html#stream_readable_stream) interface.
 *
 * ####Example
 *
 *     // follows the nodejs 0.8 stream api
 *     Thing.find({ name: /^hello/ }).stream().pipe(res)
 *
 *     // manual streaming
 *     var stream = Thing.find({ name: /^hello/ }).stream();
 *
 *     stream.on('data', function (doc) {
 *       // do something with the mongoose document
 *     }).on('error', function (err) {
 *       // handle the error
 *     }).on('close', function () {
 *       // the stream is closed
 *     });
 *
 * ####Valid options
 *
 *   - `transform`: optional function which accepts a mongoose document. The return value of the function will be emitted on `data`.
 *
 * ####Example
 *
 *     // JSON.stringify all documents before emitting
 *     var stream = Thing.find().stream({ transform: JSON.stringify });
 *     stream.pipe(writeStream);
 *
 * @return {QueryStream}
 * @param {Object} [options]
 * @see QueryStream
 * @api public
 */

MongooseQuery.prototype.stream = function stream (opts) {
  return new QueryStream(this, opts);
}

// the rest of these are basically to support older Mongoose syntax with mquery


// just a simple alias to maxScan
MongooseQuery.prototype.maxscan = function (val) {
  return MongooseQuery.base.maxScan.call(this, val);
}

/**
 * we need to support the tailable({ awaitdata : true }) as well as the
 * tailable(true, {awaitdata :true}) syntax that mquery does not support
 */

MongooseQuery.prototype.tailable = function (val, opts) {
  if (val && val.constructor.name == 'Object') {
    opts = val;
    val = true;
  }
  if (val === undefined) {
    val = true;
  }

  if (opts && opts.awaitdata) this.options.awaitdata = true;
  return MongooseQuery.base.tailable.call(this, val);
}

/**
 * This is needed to support a couple different near() forms found in older
 * versions of mongoose
 * near([1,1])
 * near(1,1)
 * near(field, [1,2])
 * near(field, 1, 2)
 * In addition to all of the normal forms supported by mquery
 */

MongooseQuery.prototype.near = function() {
  var params = [];
  var sphere = this._mongooseOptions.nearSphere;

  if (arguments.length === 1) {
    if (Array.isArray(arguments[0])) {
      params.push({ center : arguments[0], spherical : sphere });
    } else if ('string' == typeof arguments[0]) {
      params.push(arguments[0]);
    } else if (arguments[0].constructor.name == 'Object') {
      params.push(arguments[0]);
    }
  } else if (arguments.length === 2) {
    if ('number' == typeof arguments[0] && 'number' == typeof arguments[1]) {
      params.push({ center : [arguments[0], arguments[1]], spherical : sphere});
    } else if ('string' == typeof arguments[0] && Array.isArray(arguments[1])) {
      params.push(arguments[0]);
      params.push({ center : arguments[1], spherical : sphere });
    } else if ('string' == typeof arguments[0] && arguments[1].constructor.name == 'Object') {
      params.push(arguments[0]);
      params.push(arguments[1]);
    }
  } else if (arguments.length === 3) {
    if ('string' == typeof arguments[0] && 'number' == typeof arguments[1]
        && 'number' == typeof arguments[2]) {
      params.push(arguments[0]);
      params.push({ center : [arguments[1], arguments[2]], spherical : sphere });
    }
  }

  return MongooseQuery.base.near.apply(this, params);
}

/**
 * mquery just uses the spherical option in the near() modifier to enable this
 * but mongoose has this syntax as well
 */

MongooseQuery.prototype.nearSphere = function () {
  this._mongooseOptions.nearSphere = true;
  this.near.apply(this, arguments);
}

/**
 * this is needed to support the mongoose syntax of:
 * box(field, { ll : [x,y], ur : [x2,y2] })
 * box({ ll : [x,y], ur : [x2,y2] })
 */

MongooseQuery.prototype.box = function () {
  if (arguments[0] && arguments[0].constructor.name == 'Object') {
    arguments[1] = arguments[0].ur;
    arguments[0] = arguments[0].ll;
    arguments.length = 2;
  }
  if (arguments[1] && arguments[1].constructor.name == 'Object') {
    arguments[2] = arguments[1].ur;
    arguments[1] = arguments[1].ll;
    arguments.length = 3;
  }
  MongooseQuery.base.box.apply(this, arguments);
}

/**
 * Just an alias for circle()
 */

MongooseQuery.prototype.center = function () {
  MongooseQuery.base.circle.apply(this, arguments);
}

/**
 * legacy mongoose support. Basically just syntax suger
 */

MongooseQuery.prototype.centerSphere = function () {
  if (arguments[0] && arguments[0].constructor.name == 'Object') {
    arguments[0].spherical = true;
  }
  if (arguments[1] && arguments[1].constructor.name == 'Object') {
    arguments[1].spherical = true;
  }
  MongooseQuery.base.circle.apply(this, arguments);
}
module.exports = MongooseQuery;