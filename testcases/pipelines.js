if (typeof(tests) != "object") {
    tests = [];
}

/**
 * Returns a string of the given size.
 *
 * @param {Number} size - The number of characters in the resulting string.
 */
var getStringOfLength = function() {
    var cache = {};
    return function getStringOfLength(size) {
        if (!cache[size]) {
            cache[size] = new Array(size + 1).join("x");
        }
        return cache[size];
    };
}();

/**
 * Generates a generic document to use in aggregation pipelines that don't care what the data looks
 * like. These documents are at least 12 KB in size.
 *
 * @param {Number} i - Which number document this is in the collection, monotonically increasing.
 */
function defaultDocGenerator(i) {
    return {
        _id: new ObjectId(),
        string: getStringOfLength(12 * 1000),  // 12 KB.
        sub_docs: [
            {_id: new ObjectId(), x: i, y: i * i}
        ],
        metadata: {
            about: "Used only for performance testing",
            created: new ISODate()
        }
    };
}

/**
 * Returns a function which will populate a collection with 'nDocs' documents, each document
 * generated by calling 'docGenerator' with the document number. Will also create all indices
 * specified in 'indices' on the given collection. Also seeds the random number generator.
 *
 * @param {Object[]} indices - An array of index specifications to be created on the collection.
 * @param {function} docGenerator - A function that takes a document number and returns a document.
 * Used to seed the collection.
 * @param {Number} nDocs - The number of documents to insert into the collection.
 */
function populatorGenerator(nDocs, indices, docGenerator) {
    return function(collection) {
        collection.drop();
        var bulkop = collection.initializeUnorderedBulkOp();
        Random.setRandomSeed();

        for (var i = 0; i < nDocs; i++) {
            bulkop.insert(docGenerator(i));
        }
        bulkop.execute();
        indices.forEach(function(indexSpec) {
            assert.commandWorked(collection.ensureIndex(indexSpec));
        });
        collection.getDB().getLastError();
    };
}

/**
 * Returns a test case object that can be used by {@link #runTests}.
 *
 * @param {Object} options - Options describing the test case.
 * @param {String} options.name - The name of the test case. "Aggregation." will be prepended.
 * @param {Object[]} options.pipeline - The aggregation pipeline to run.
 *
 * @param {String[]} [options.tags=["aggregation", "core", "regression"]] - The tags describing what
 * type of test this is.
 * @param {Object[]} [options.indices=[]] - An array of index specifications to create on the
 * collection.
 * @param {Number} [options.nDocs=500] - The number of documents to insert in the collection.
 * @param {function} [options.docGenerator=defaultDocGenerator] - A function that takes a document
 * number and returns a document. Used to seed the collection. The random number generator will be
 * seeded before the first call.
 */
function testCaseGenerator(options) {
    return {
        tags: options.tags || ["aggregation", "core", "regression"],
        name: "Aggregation." + options.name,
        pre: populatorGenerator(500,
                                options.indices || [],
                                options.docGenerator || defaultDocGenerator),
        ops: [
            {
                op: "command",
                ns: "#B_DB",
                command: {
                    aggregate: "#B_COLL",
                    pipeline: options.pipeline,
                    cursor: {}
                }
            }
        ]
    };
}

//
// Empty pipeline.
//

tests.push(testCaseGenerator({
    name: "Empty",
    pipeline: []
}));

//
// Single stage pipelines.
//

tests.push(testCaseGenerator({
    name: "GeoNear2d",
    docGenerator: function geoNear2dGenerator(i) {
        return {
            _id: i,
            geo: [
                // Two random values in range [-100, 100).
                Random.randInt(200) - 100,
                Random.randInt(200) - 100
            ],
            boolFilter: i % 2 === 0
        };
    },
    indices: [{geo: "2d"}],
    pipeline: [
        {
            $geoNear: {
                near: [0, 0],
                minDistance: 0,
                maxDistance: 300,
                distanceField: "foo",
                query: {
                    boolFilter: true
                }
            }
        }
    ]
}));

tests.push(testCaseGenerator({
    name: "GeoNear2dSphere",
    indices: [{geo: "2dsphere"}],
    docGenerator: function geoNear2dGenerator(i) {
        return {
            _id: i,
            geo: [
                (Random.rand() * 360) - 180,  // Longitude, in range [-180, 180).
                (Random.rand() * 180) - 90  // Latitude, in range [-90, 90).
            ],
            boolFilter: i % 2 === 0
        };
    },
    pipeline: [
        {
            $geoNear: {
                near: [0, 0],
                minDistance: 0,
                maxDistance: 300,
                distanceField: "foo",
                query: {
                    boolFilter: true
                },
                spherical: true
            }
        }
    ]
}));

tests.push(testCaseGenerator({
    name: "Group.All",
    pipeline: [{$group: {_id: "constant"}}]
}));

tests.push(testCaseGenerator({
    name: "Group.TenGroups",
    docGenerator: function basicGroupDocGenerator(i) {
        return {_id: i, _idMod10: i % 10};
    },
    pipeline: [{$group: {_id: "$_idMod10"}}]
}));

tests.push(testCaseGenerator({
    name: "Limit",
    nDocs: 500,
    pipeline: [{$limit: 250}]
}));

// $lookup tests need two collections, so they use their own setup code.
tests.push({
    tags: ["aggregation", "core", "regression"],
    name: "Aggregation.Lookup",
    // The setup function is only given one collection, but $lookup needs two. We'll treat the given
    // one as the source collection, and create a second one with the name of the first plus
    // '_lookup', which we'll use to look up from.
    pre: function lookupPopulator(sourceCollection) {
        var lookupCollName = sourceCollection.getName() + "_lookup";
        var lookupCollection = sourceCollection.getCollection(lookupCollName);
        var nDocs = 500;

        sourceCollection.drop();
        lookupCollection.drop();

        var sourceBulk = sourceCollection.initializeUnorderedBulkOp();
        var lookupBulk = lookupCollection.initializeUnorderedBulkOp();
        for (var i = 0; i < nDocs; i++) {
            sourceBulk.insert({_id: i, foreignKey: i});
            lookupBulk.insert({_id: i});
        }
        sourceBulk.execute();
        lookupBulk.execute();
    },
    ops: [
        {
            op: "command",
            ns: "#B_DB",
            command: {
                aggregate: "#B_COLL",
                pipeline: [
                    {
                        $lookup: {
                            from: "#B_COLL_lookup",
                            localField: "foreignKey",
                            foreignField: "_id",
                            as: "match"
                        }
                    }
                ],
                cursor: {}
            }
        }
    ]
});

tests.push({
    tags: ["aggregation", "core", "regression"],
    name: "Aggregation.LookupOrders",
    // The setup function is only given one collection, but $lookup needs two. We'll treat the given
    // one as a collection of orders, and create a second one with the name of the first plus
    // '_lookup', which we'll use as a collection of products, referred to by the orders.
    pre: function lookupPopulator(ordersCollection) {
        var productCollName = ordersCollection.getName() + "_lookup";
        var productsCollection = ordersCollection.getCollection(productCollName);
        var nDocs = 500;

        productsCollection.drop();
        ordersCollection.drop();

        // Insert orders, referencing products.
        Random.setRandomSeed(parseInt("5ca1ab1e", 16));
        var productsBulk = productsCollection.initializeUnorderedBulkOp();
        var ordersBulk = ordersCollection.initializeUnorderedBulkOp();
        for (var i = 0; i < nDocs; i++) {
            // Products are simple, just an _id.
            productsBulk.insert({_id: i});

            // Each order will contain a random number of products in an array.
            var nProducts = Random.randInt(100);
            var products = [];
            for (var p = 0; p < nProducts; p++) {
                products.push({_id: Random.randInt(nDocs), quantity: Random.randInt(20)});
            }

            ordersBulk.insert({
                _id: new ObjectId(),
                products: products,
                ts: new ISODate()
            });
        }
        productsBulk.execute();
        ordersBulk.execute();
    },
    ops: [
        {
            op: "command",
            ns: "#B_DB",
            command: {
                aggregate: "#B_COLL",
                pipeline: [
                    {
                        $unwind: "$products"
                    },
                    {
                        $lookup: {
                            from: "#B_COLL_lookup",
                            localField: "products._id",
                            foreignField: "_id",
                            as: "product"
                        }
                    }
                ],
                cursor: {}
            }
        }
    ]
});

tests.push(testCaseGenerator({
    name: "Match",
    nDocs: 500,
    docGenerator: function simpleMatchDocGenerator(i) {
        return {_id: i};
    },
    pipeline: [{$match: {_id: {$lt: 250}}}]
}));

tests.push(testCaseGenerator({
    name: "Out",
    pipeline: [{$out: (new ObjectId()).str}]
}));

tests.push(testCaseGenerator({
    name: "Project",
    docGenerator: function simpleProjectionDocGenerator(i) {
        return {_id: i, w: i, x: i, y: i, z: i};
    },
    pipeline: [{$project: {_id: 0, x: 1, y: 1}}]
}));

tests.push(testCaseGenerator({
    name: "Redact",
    docGenerator: function simpleRedactDocGenerator(i) {
        return {_id: i, has_permissions: i % 2 === 0};
    },
    pipeline: [
        {
            $redact: {
                $cond: {
                    if: {$eq: ["$has_permissions", true]},
                    then: "$$DESCEND",
                    else: "$$PRUNE"
                }
            }
        }
    ]
}));

tests.push(testCaseGenerator({
    name: "Sample.SmallSample",
    nDocs: 500,
    pipeline: [{$sample: {size: 5}}]
}));

tests.push(testCaseGenerator({
    name: "Sample.LargeSample",
    nDocs: 500,
    pipeline: [{$sample: {size: 200}}]
}));

tests.push(testCaseGenerator({
    name: "Skip",
    nDocs: 500,
    pipeline: [{$skip: 250}]
}));

tests.push(testCaseGenerator({
    name: "Sort",
    docGenerator: function simpleSortDocGenerator(i) {
        return {_id: i, x: Random.rand()};
    },
    pipeline: [{$sort: {x: 1}}]
}));

tests.push(testCaseGenerator({
    name: "Unwind",
    docGenerator: function simpleUnwindDocGenerator(i) {
        return {
            _id: i,
            array: [1, "some string data", new ObjectId(), null, NumberLong(23), [4, 5], {x: 1}]
        };
    },
    pipeline: [{$unwind: {path: "$array", includeArrayIndex: "index"}}]
}));
