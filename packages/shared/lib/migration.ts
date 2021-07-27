import { TRANSACTION_LENGTH } from '@iota/transaction'
import { asTransactionObject } from '@iota/transaction-converter'
import { addEntry, finalizeBundle } from '@iota/bundle'
import { tritsToTrytes, trytesToTrits, valueToTrits } from '@iota/converter'
import { getOfficialNetwork } from 'shared/lib/network'
import { closePopup, openPopup } from 'shared/lib/popup'
import { activeProfile, updateProfile } from 'shared/lib/profile'
import { appRoute, walletSetupType } from 'shared/lib/router'
import type { Address } from 'shared/lib/typings/address'
import type { Input, MigrationBundle, MigrationData, AddressInput, MigrationAddress, Transfer } from 'shared/lib/typings/migration'
import { AppRoute, SetupType } from 'shared/lib/typings/routes'
import Validator from 'shared/lib/validator'
import { api } from 'shared/lib/wallet'
import { derived, get, writable, Writable } from 'svelte/store'
import { localize } from './i18n'

export const LOG_FILE_NAME = 'migration.log'

// TODO: Change back temp migration nodes (previously https://nodes.devnet.iota.org)
export const MIGRATION_NODES = ['https://nodes-legacy.ledgermigration1.net']
export const PERMANODE = "http://permanode.ledgermigration1.net:4000/api"

export const ADDRESS_SECURITY_LEVEL = 2

/** Minimum migration balance */
export const MINIMUM_MIGRATION_BALANCE = 1000000

/** Bundle mining timeout for each bundle */
export const MINING_TIMEOUT_SECONDS = 10

// TODO: Change back temp mwm (previously 9)
export const MINIMUM_WEIGHT_MAGNITUDE = 14;

const SOFTWARE_MAX_INPUTS_PER_BUNDLE = 10

const HARDWARE_MAX_INPUTS_PER_BUNDLE = 3

const HARDWARE_ADDRESS_GAP = 3

const CHECKSUM_LENGTH = 9

interface MigrationLog {
    bundleHash: string;
    trytes: string[];
    receiveAddressTrytes: string;
    balance: number;
    timestamp: string;
    spentAddresses: string[];
    spentBundleHashes: string[];
    mine: boolean;
    crackability: number | null
}

interface Bundle {
    index: number;
    shouldMine: boolean;
    selectedToMine: boolean;
    bundleHash?: string;
    crackability?: number;
    migrated: boolean;
    selected: boolean;
    inputs: Input[];
    miningRuns: number;
    confirmed: boolean;
    trytes?: string[];
}

interface HardwareIndexes {
    accountIndex: number;
    pageIndex: number;
}

interface MigrationState {
    didComplete: Writable<boolean>;
    data: Writable<MigrationData>,
    seed: Writable<string>
    bundles: Writable<Bundle[]>
}

export enum LedgerMigrationProgress {
    InstallLedgerApp,
    GenerateAddress,
    SwitchLedgerApp,
    TransferFunds,
}

export const removeAddressChecksum = (address: string = '') => {
    return address.slice(0, -CHECKSUM_LENGTH)
}

export const currentLedgerMigrationProgress = writable<LedgerMigrationProgress>(null)
export const ledgerMigrationProgresses = derived(currentLedgerMigrationProgress, _currentLedgerMigrationProgress => {
    // had to add this here otherwise it gives error
    const LEDGER_MIGRATION_PROGRESSES = [
        {
            title: localize('views.setupLedger.progress1'),
            state: LedgerMigrationProgress.InstallLedgerApp,
        },
        {
            title: localize('views.setupLedger.progress2'),
            state: LedgerMigrationProgress.GenerateAddress,
        },
        {
            title: localize('views.setupLedger.progress3'),
            state: LedgerMigrationProgress.SwitchLedgerApp,
        },
        {
            title: localize('views.setupLedger.progress4'),
            state: LedgerMigrationProgress.TransferFunds,
        },
    ]
    return LEDGER_MIGRATION_PROGRESSES.map((step, index) => {
        return ({
            ...step,
            ongoing: _currentLedgerMigrationProgress === index,
            complete: index < _currentLedgerMigrationProgress,
        })
    })
})
// TODO: replace with final one
export const LEDGER_MIGRATION_VIDEO = 'https://files.iota.org/firefly/test-video.mp4'

/*
 * Migration state
 */
export const migration = writable<MigrationState>({
    didComplete: writable<boolean>(false),
    data: writable<MigrationData>({
        lastCheckedAddressIndex: 0,
        balance: 0,
        inputs: [],
    }),
    seed: writable<string>(null),
    bundles: writable<Bundle[]>([])
})

export const hardwareIndexes = writable<HardwareIndexes>({
    accountIndex: 0,
    pageIndex: 0
})

export const migrationLog = writable<MigrationLog[]>([]);

/**
 * TODO: Remove this before it gets to production.
 * This is only added for testing purposes.
 */
export const legacyAddressForTesting = writable<string>(null);

/*
 * Chrysalis status
 */
export const chrysalisLive = writable<Boolean>(false)
/*
 * ongoingSnapshot
 */
export const ongoingSnapshot = writable<Boolean>(false)

export const createUnsignedBundle = (
    outputAddress: string,
    inputAddresses: string[],
    value: number,
    timestamp: number,
    securityLevel = ADDRESS_SECURITY_LEVEL
): string[] => {
    let bundle = new Int8Array();
    const issuanceTimestamp = valueToTrits(timestamp);

    bundle = addEntry(bundle, {
        address: trytesToTrits(outputAddress),
        value: valueToTrits(value),
        issuanceTimestamp,
    });

    inputAddresses.forEach((inputAddress) => {
        // For every security level, create a new zero-value transaction to which you can later add the rest of the signature fragments
        for (let i = 0; i < securityLevel; i++) {
            bundle = addEntry(bundle, {
                address: trytesToTrits(inputAddress),
                value: valueToTrits(i == 0 ? -value : 0),
                issuanceTimestamp,
            });
        }
    })

    bundle = finalizeBundle(bundle)

    const bundleTrytes = []

    for (let offset = 0; offset < bundle.length; offset += TRANSACTION_LENGTH) {
        bundleTrytes.push(tritsToTrytes(bundle.subarray(offset, offset + TRANSACTION_LENGTH)))
    }

    return bundleTrytes;
}

/**
 * Gets migration data and sets it to state
 * 
 * @method getMigrationData
 * 
 * @param {string} migrationSeed 
 * @param {number} initialAddressIndex 
 * 
 * @returns {Promise<void} 
 */
export const getMigrationData = (migrationSeed: string, initialAddressIndex = 0): Promise<void> => {
    return new Promise(async (resolve, reject) => {
        if (get(ongoingSnapshot) === true) {
            reject({ snapshot: true })
            openSnapshotPopup()
        }
        else {
            api.getMigrationData(
                migrationSeed,
                MIGRATION_NODES,
                ADDRESS_SECURITY_LEVEL,
                initialAddressIndex,
                PERMANODE, {
                onSuccess(response) {
                    const { seed, data } = get(migration)

                    if (initialAddressIndex === 0) {
                        seed.set(migrationSeed)
                        data.set(response.payload)
                    } else {
                        data.update((_existingData) => {
                            return Object.assign({}, _existingData, {
                                balance: _existingData.balance + response.payload.balance,
                                inputs: [..._existingData.inputs, ...response.payload.inputs],
                                lastCheckedAddressIndex: response.payload.lastCheckedAddressIndex
                            })
                        })
                    }

                    prepareBundles()

                    resolve()
                },
                onError(error) {
                    reject(error)
                },
            })
        }

    })
};

/**
 * Prepares migration log 
 * 
 * @method prepareMigrationLog
 * 
 * @param {string} bundleHash 
 * @param {string[]} trytes 
 * @param {number} balance 
 * @param [boolean] mine 
 * @param [number] crackability
 * 
 * @returns {void} 
 */
export const prepareMigrationLog = (bundleHash: string, trytes: string[], balance: number) => {
    const transactionObjects = trytes.map((tryteString) => asTransactionObject(tryteString));
    const { bundles } = get(migration);

    const bundle = get(bundles).find((bundle) => bundle.bundleHash === bundleHash);
    const spentInputs = bundle.inputs.filter((input) => input.spent === true)

    const spentBundleHashes = [];

    spentInputs.forEach((input) => {
        input.spentBundleHashes.forEach((bundleHash) => {
            spentBundleHashes.push(bundleHash);
        })
    });

    migrationLog.update((_log) => [
        ..._log,
        {
            bundleHash: transactionObjects[0].bundle,
            timestamp: new Date().toISOString(),
            trytes,
            receiveAddressTrytes: transactionObjects.find((tx) => tx.address.startsWith('TRANSFER')).address,
            balance,
            spentBundleHashes,
            spentAddresses: bundle.inputs.filter((input) => input.spent === true).map((input) => input.address),
            mine: bundle.miningRuns > 0,
            crackability: bundle.crackability
        }
    ])
};


/**
 * Gets migration data for ledger accounts
 * 
 * @method getLedgerMigrationData
 * 
 * @returns {Promise<void>}
 */
export const getLedgerMigrationData = (getAddressFn: (index: number) => Promise<string>, callback: () => void): Promise<any> => {
    const _get = (addresses: AddressInput[]): Promise<any> => {
        return new Promise((resolve, reject) => {
            api.getLedgerMigrationData(
                addresses,
                MIGRATION_NODES,
                PERMANODE,
                ADDRESS_SECURITY_LEVEL,
                {
                    onSuccess(response) {
                        resolve(response)
                    },
                    onError(error) {
                        reject(error);
                    }
                }
            )
        })
    }

    const _generate = () => {
        const { data } = get(migration)

        return Array.from(Array(HARDWARE_ADDRESS_GAP), (_, i) => i).reduce((promise, index) => {
            let idx = 0;
            const lastCheckedAddressIndex = get(data).lastCheckedAddressIndex;
            if (lastCheckedAddressIndex === 0) {
                idx = index + lastCheckedAddressIndex
            } else {
                idx = index + lastCheckedAddressIndex + 1
            }

            return promise.then(acc => (
                getAddressFn(idx).then(address => acc.concat({ address, index: idx }))
            )
            )
        }, Promise.resolve([]))
    };

    const _process = () => {
        return _generate().then((addresses) => {
            const _addresses = addresses.map((address) => address.address)
            // TODO: Remove this
            // ----------------------------------------------------------------
            // Added for internal testing so that testers can copy addresses
            console.log('-'.repeat(20))
            _addresses.forEach((address) => console.log(address));
            console.log('-'.repeat(20))

            legacyAddressForTesting.set(_addresses[_addresses.length - 1])
            // ----------------------------------------------------------------
            // End of the part that needs to be removed.

            return _get(addresses)
        }).then((response: any) => {
            const { data } = get(migration)

            if (get(data).lastCheckedAddressIndex === 0) {
                data.set(response.payload)
            } else {
                data.update((_existingData) => {
                    return Object.assign({}, _existingData, {
                        balance: _existingData.balance + response.payload.balance,
                        inputs: [..._existingData.inputs, ...response.payload.inputs],
                        lastCheckedAddressIndex: response.payload.lastCheckedAddressIndex
                    })
                })
            }

            prepareBundles()
            return response.payload.spentAddresses === true || response.payload.inputs.length > 0 || response.payload.balance > 0;
        });
    }

    return _process().then((shouldGenerateMore) => {
        if (shouldGenerateMore) {
            return _process();
        }

        return Promise.resolve(true);
    }).then(() => {
        callback()
        return get(get(migration).data)
    })
};

/**
 * Mines ledger bundle
 * 
 * @method mineLedgerBundle
 * 
 * @param {number} bundleIndex 
 * @param {number} offset 
 *
 * @returns 
 */
export const mineLedgerBundle = (
    bundleIndex: number,
    offset: number,
): Promise<void> => {
    return new Promise((resolve, reject) => {
        api.getMigrationAddress(false, get(activeProfile).ledgerMigrationCount, {
            onSuccess(response) {
                resolve(response.payload)
            },
            onError(error) {
                reject(error)
            }
        })
    }).then((address: MigrationAddress) => {
        const { bundles } = get(migration);

        const bundle = get(bundles).find((bundle) => bundle.index === bundleIndex);

        const spentBundleHashes = []

        bundle.inputs.forEach((input) => spentBundleHashes.push(...input.spentBundleHashes))

        const unsignedBundle = createUnsignedBundle(
            removeAddressChecksum(address.trytes),
            bundle.inputs.map((input) => input.address),
            bundle.inputs.reduce((acc, input) => acc + input.balance, 0),
            Math.floor(Date.now() / 1000),
            ADDRESS_SECURITY_LEVEL
        );

        return new Promise((resolve, reject) => {
            api.mineBundle(
                unsignedBundle.slice().reverse(),
                spentBundleHashes,
                ADDRESS_SECURITY_LEVEL,
                MINING_TIMEOUT_SECONDS,
                offset,
                {
                    onSuccess(response) {
                        resolve(response.payload)
                    },
                    onError(error) {
                        reject(error)
                    }
                }
            )
        }).then((payload) => {
            // @ts-ignore
            updateLedgerBundleState(bundleIndex, payload.bundle, true, payload.crackability)
        })

    });
};

/**
 * Create mined ledger migration bundle
 * 
 * @method createMinedLedgerMigrationBundle
 * 
 * @param {number} bundleIndex 
 * @param {function} prepareTransfersFn 
 * 
 * @returns {Promise<void>}
 */
export const createMinedLedgerMigrationBundle = (
    bundleIndex: number,
    prepareTransfersFn: (
        transfers: Transfer[],
        inputs: Input[],
        remainder: undefined,
        now: () => number
    ) => Promise<string[]>,
    callback: () => void
) => {
    const { bundles } = get(migration);

    const bundle = get(bundles).find((bundle) => bundle.index === bundleIndex);
    const txs = bundle.trytes.map((tryte) => asTransactionObject(tryte));

    const transfer = bundle.trytes.
        map((tryte) => asTransactionObject(tryte))
        .reduce((acc, tx) => {
            if (tx.address.startsWith('TRANSFER')) {
                acc.address = tx.address;
                acc.value = tx.value;
                acc.tag = tx.obsoleteTag;
            }

            return acc;
        }, {
            address: '',
            value: 0,
            tag: ''
        })

    const inputs = bundle.inputs.map((input) => {
        const tags = txs.filter((tx) => tx.address === input.address).sort((a, b) => {
            return a.value - b.value;
        }).map((tx) => tx.obsoleteTag);

        return Object.assign({}, input, {
            keyIndex: input.index,
            tags
        })
    })

    openLedgerLegacyTransactionPopup(transfer, inputs)

    return prepareTransfersFn([transfer], inputs, undefined, () => txs[0].timestamp * 1000).then((trytes) => {
        updateLedgerBundleState(bundleIndex, trytes, false);
        callback()
        return { trytes, bundleHash: asTransactionObject(trytes[0]).bundle }
    });
};

/**
 * Creates migration bundle for ledger
 *
 * @method createLedgerMigrationBundle
 *
 * @param {number} bundleIndex
 * @param {function} prepareTransfersFn
 *
 * @returns {Promise}
 */
export const createLedgerMigrationBundle = (
    bundleIndex: number,
    prepareTransfersFn: (
        transfers: Transfer[],
        inputs: Input[],
    ) => Promise<string[]>,
    callback: () => void
): Promise<any> => {
    return new Promise((resolve, reject) => {
        api.getMigrationAddress(false, get(activeProfile).ledgerMigrationCount, {
            onSuccess(response) {
                resolve(response.payload);
            },
            onError(error) {
                reject(error)
            }
        })
    }).then((address: MigrationAddress) => {
        const { bundles } = get(migration);

        const bundle = get(bundles).find((bundle) => bundle.index === bundleIndex);

        const transfer = {
            address: address.trytes.toString(),
            value: bundle.inputs.reduce((acc, input) => acc + input.balance, 0),
            tag: 'U'.repeat(27)
        }

        openLedgerLegacyTransactionPopup(transfer, bundle.inputs)

        return prepareTransfersFn([transfer], bundle.inputs.map((input) => Object.assign({}, input, { keyIndex: input.index }))).then((trytes) => {
            updateLedgerBundleState(bundleIndex, trytes, false);
            callback()
            return { trytes, bundleHash: asTransactionObject(trytes[0]).bundle }
        });
    });
};

/**
 * Sends ledger migration bundle
 * 
 * @method sendLedgerMigrationBundle
 * 
 * @param {string[]} trytes
 *  
 * @returns {Promise}
 */
export const sendLedgerMigrationBundle = (bundleHash: string, trytes: string[]): Promise<any> => {
    return new Promise((resolve, reject) => {
        api.sendLedgerMigrationBundle(
            MIGRATION_NODES,
            trytes,
            MINIMUM_WEIGHT_MAGNITUDE,
            {
                onSuccess(response) {
                    // Store migration log so that we can export it later
                    prepareMigrationLog(bundleHash, trytes, response.payload.value)

                    const { bundles } = get(migration);

                    // Update bundle and mark it as migrated
                    bundles.update((_bundles) => {
                        return _bundles.map((bundle) => {
                            if (bundle.bundleHash === bundleHash) {
                                return Object.assign({}, bundle, { migrated: true })
                            }

                            return bundle
                        })
                    })

                    // Persist these bundles in local storage
                    const _activeProfile = get(activeProfile)

                    const migratedTransaction = {
                        address: response.payload.address,
                        balance: response.payload.value,
                        tailTransactionHash: response.payload.tailTransactionHash,
                        timestamp: new Date().toISOString(),
                        // Account index. Since we migrate funds to account at 0th index
                        account: 0
                    }

                    updateProfile(
                        'migratedTransactions',
                        _activeProfile.migratedTransactions ? [..._activeProfile.migratedTransactions, migratedTransaction] : [migratedTransaction]
                    )

                    resolve(response)
                },
                onError(error) { reject(error) }
            }
        )
    })
};

/**
 * Creates migration bundle
 * 
 * @method createMigrationBundle
 * 
 * @param {number[]} inputIndexes 
 * @param {boolean} mine
 * 
 * @returns {Promise}
 */
export const createMigrationBundle = (inputAddressIndexes: number[], offset: number, mine: boolean): Promise<any> => {
    const { seed } = get(migration)

    return new Promise((resolve, reject) => {
        api.createMigrationBundle(get(seed), inputAddressIndexes, mine, MINING_TIMEOUT_SECONDS, offset, LOG_FILE_NAME, {
            onSuccess(response) {
                assignBundleHash(inputAddressIndexes, response.payload, mine)
                resolve(response)
            },
            onError(error) {
                reject(error)
            },
        })
    })
};

/**
 * Signs and broadcast bundle to the (legacy) network
 * 
 * @method sendMigrationBundle
 * 
 * @param {string} bundleHash 
 * @param {number} [mwm]
 *  
 * @returns {Promise<void>}
 */
export const sendMigrationBundle = (bundleHash: string, mwm = MINIMUM_WEIGHT_MAGNITUDE): Promise<void> => {
    return new Promise(async (resolve, reject) => {
        if (get(ongoingSnapshot) === true) {
            reject({ snapshot: true })
            openSnapshotPopup()
        }
        else {
            api.sendMigrationBundle(MIGRATION_NODES, bundleHash, mwm, {
                onSuccess(response) {
                    const { bundles } = get(migration);

                    // Update bundle and mark it as migrated
                    bundles.update((_bundles) => {
                        return _bundles.map((bundle) => {
                            if (bundle.bundleHash === bundleHash) {
                                return Object.assign({}, bundle, { migrated: true })
                            }

                            return bundle
                        })
                    })

                    // Persist these bundles in local storage
                    const _activeProfile = get(activeProfile)

                    const migratedTransaction = {
                        address: response.payload.address,
                        balance: response.payload.value,
                        tailTransactionHash: response.payload.tailTransactionHash,
                        timestamp: new Date().toISOString(),
                        // Account index. Since we migrate funds to account at 0th index
                        account: 0
                    }

                    updateProfile(
                        'migratedTransactions',
                        _activeProfile.migratedTransactions ? [..._activeProfile.migratedTransactions, migratedTransaction] : [migratedTransaction]
                    )
                    resolve()
                },
                onError(error) {
                    reject(error)
                },
            })
        }
    })
}

/**
 * Assigns bundle hash and crackability score to bundles
 * 
 * @method assignBundleHash
 * 
 * @param inputAddressIndexes 
 * @param migrationBundle 
 * 
 * @returns {void}
 */
export const assignBundleHash = (inputAddressIndexes: number[], migrationBundle: MigrationBundle, didMine: boolean): void => {
    const { bundles } = get(migration);

    bundles.update((_bundles) => {
        return _bundles.map((bundle) => {
            const indexes = bundle.inputs.map((input) => input.index);
            if (indexes.length && indexes.every((index) => inputAddressIndexes.includes(index))) {
                const isNewCrackabilityScoreLowerThanPrevious = bundle.bundleHash && bundle.crackability && migrationBundle.crackability < bundle.crackability

                // If bundle hash is already set, that means bundle mining has already been performed for this
                if (bundle.bundleHash) {
                    return Object.assign({}, bundle, {
                        miningRuns: didMine ? bundle.miningRuns + 1 : bundle.miningRuns,
                        bundleHash: isNewCrackabilityScoreLowerThanPrevious ? migrationBundle.bundleHash : bundle.bundleHash,
                        crackability: isNewCrackabilityScoreLowerThanPrevious ? migrationBundle.crackability : bundle.crackability
                    })
                }

                return Object.assign({}, bundle, {
                    miningRuns: didMine ? bundle.miningRuns + 1 : bundle.miningRuns,
                    bundleHash: migrationBundle.bundleHash,
                    crackability: migrationBundle.crackability
                })
            }

            return bundle
        })
    })
};

/**
 * Updates ledger bundle state
 * 
 * @method updateLedgerBundleState
 * 
 * @param {number} bundleIndex 
 * @param {string[]} trytes 
 * @param {boolean} didMine 
 * @param [number] migrationBundleCrackability
 * 
 * @returns {void} 
 */
export const updateLedgerBundleState = (bundleIndex: number, trytes: string[], didMine: boolean, migrationBundleCrackability?: number) => {
    const { bundles } = get(migration);

    bundles.update((_bundles) => {
        return _bundles.map((bundle) => {
            if (bundle.index === bundleIndex) {
                const newBundleHash = asTransactionObject(trytes[0]).bundle

                if (bundle.miningRuns > 0) {
                    const isNewCrackabilityScoreLowerThanPrevious = bundle.bundleHash && bundle.crackability && migrationBundleCrackability < bundle.crackability

                    return Object.assign({}, bundle, {
                        trytes,
                        miningRuns: didMine ? bundle.miningRuns + 1 : bundle.miningRuns,
                        bundleHash: isNewCrackabilityScoreLowerThanPrevious ? newBundleHash : bundle.bundleHash,
                        crackability: isNewCrackabilityScoreLowerThanPrevious ? migrationBundleCrackability : bundle.crackability
                    })
                }

                return Object.assign({}, bundle, {
                    trytes,
                    miningRuns: didMine ? bundle.miningRuns + 1 : bundle.miningRuns,
                    bundleHash: newBundleHash,
                    crackability: migrationBundleCrackability
                })
            }

            return bundle
        })
    })
};

/**
 * Prepares inputs (as bundles) for unspent addresses.
 * Steps:
 *   - Categorises inputs in two groups 1) inputs with balance >= MINIMUM_MIGRATION_BALANCE 2) inputs with balance < MINIMUM_MIGRATION_BALANCE
 *   - Creates chunks of category 1 input addresses such that length of each chunk should not exceed MAX_INPUTS_PER_BUNDLE
 *   - For category 2: 
 *         - Sort the inputs in descending order based on balance;
 *         - Pick first N inputs (where N = MAX_INPUTS_PER_BUNDLE) and see if their accumulative balance >= MINIMUM_MIGRATION_BALANCE
 *         - If yes, then repeat the process for next N inputs. Otherwise, iterate on the remaining inputs and add it to a chunk that has space for more inputs
 *         - If there's no chunk with space left, then ignore these funds. NOTE THAT THESE FUNDS WILL ESSENTIALLY BE LOST!
 * 
 * NOTE: If the total sum of provided inputs are less than MINIMUM_MIGRATION_BALANCE, then this method will just return and empty array as those funds can't be migrated.
 * 
 * This method gives precedence to max inputs over funds. It ensures, a maximum a bundle could have is 30 inputs and their accumulative balance >= MINIMUM_MIGRATION_BALANCE
 * 
 * @method selectInputsForUnspentAddresses
 * 
 * @params {Input[]} inputs
 * 
 * @returns {Input[][]}
 */
const selectInputsForUnspentAddresses = (inputs: Input[]): Input[][] => {
    const MAX_INPUTS_PER_BUNDLE = get(walletSetupType) === SetupType.TrinityLedger ? HARDWARE_MAX_INPUTS_PER_BUNDLE : SOFTWARE_MAX_INPUTS_PER_BUNDLE;

    const totalInputsBalance: number = inputs.reduce((acc, input) => acc + input.balance, 0);

    // If the total sum of unspent addresses is less than MINIMUM MIGRATION BALANCE, just return an empty array as these funds cannot be migrated
    if (totalInputsBalance < MINIMUM_MIGRATION_BALANCE) {
        return [];
    }

    const { inputsWithEnoughBalance, inputsWithLowBalance } = inputs.reduce((acc, input) => {
        if (input.balance >= MINIMUM_MIGRATION_BALANCE) {
            acc.inputsWithEnoughBalance.push(input);
        } else {
            acc.inputsWithLowBalance.push(input);
        }

        return acc;
    }, { inputsWithEnoughBalance: [], inputsWithLowBalance: [] })

    let chunks = inputsWithEnoughBalance.reduce((acc, input, index) => {
        const chunkIndex = Math.floor(index / MAX_INPUTS_PER_BUNDLE)

        if (!acc[chunkIndex]) {
            acc[chunkIndex] = [] // start a new chunk
        }

        acc[chunkIndex].push(input)

        return acc
    }, [])

    const fill = (_inputs) => {
        _inputs.every((input) => {
            const chunkIndexWithSpaceForInput = chunks.findIndex((chunk) => chunk.length < MAX_INPUTS_PER_BUNDLE);

            if (chunkIndexWithSpaceForInput > -1) {
                chunks = chunks.map((chunk, idx) => {
                    if (idx === chunkIndexWithSpaceForInput) {
                        return [...chunk, input]
                    }

                    return chunk
                })

                return true;
            }

            // If there is no space, then exit
            return false;
        })
    }

    const totalBalanceOnInputsWithLowBalance: number = inputsWithLowBalance.reduce((acc, input) => acc + input.balance, 0)

    // If all the remaining input addresses have accumulative balance less than the minimum migration balance,
    // Then sort the inputs in descending order and try to pair the
    if (totalBalanceOnInputsWithLowBalance < MINIMUM_MIGRATION_BALANCE) {
        const sorted = inputsWithLowBalance.slice().sort((a, b) => b.balance - a.balance)

        fill(sorted)
    } else {
        let startIndex = 0

        const sorted = inputsWithLowBalance.slice().sort((a, b) => b.balance - a.balance)
        const max = Math.ceil(sorted.length / MAX_INPUTS_PER_BUNDLE);

        while (startIndex < max) {
            const inputsSubset = sorted.slice(startIndex * MAX_INPUTS_PER_BUNDLE, (startIndex + 1) * MAX_INPUTS_PER_BUNDLE)
            const balanceOnInputsSubset = inputsSubset.reduce((acc, input) => acc + input.balance, 0);

            if (balanceOnInputsSubset >= MINIMUM_MIGRATION_BALANCE) {
                chunks = [...chunks, inputsSubset]
            } else {
                fill(inputsSubset)
            }

            startIndex++;
        }
    }

    return chunks;
};

/**
 * Prepares bundles from inputs
 * 
 * @method prepareBundles
 * 
 * @returns {void}
 */
export const prepareBundles = () => {
    const { data, bundles } = get(migration)

    const { inputs } = get(data)

    // Categorise spent vs unspent inputs
    const { spent, unspent } = inputs.reduce((acc, input) => {
        if (input.spent) {
            acc.spent.push(input)
        } else {
            acc.unspent.push(input)
        }

        return acc;
    }, { spent: [], unspent: [] })

    const unspentInputChunks = selectInputsForUnspentAddresses(unspent)
    const spentInputs = spent.filter((input) => input.balance >= MINIMUM_MIGRATION_BALANCE)

    const _shouldMine = (input) => (input.spentBundleHashes && input.spentBundleHashes.length > 0)

    bundles.set([
        ...spentInputs.map((input) => ({ confirmed: false, miningRuns: 0, migrated: false, selected: true, shouldMine: _shouldMine(input), selectedToMine: true, inputs: [input] })),
        ...unspentInputChunks.map((inputs) => ({ confirmed: false, miningRuns: 0, migrated: false, selected: true, shouldMine: false, selectedToMine: false, inputs }))
    ].map((_, index) => ({ ..._, index })))
};

/**
 * Gets input indexes for all addresses / inputs in a bundle
 * 
 * @method getInputIndexesForBundle
 * 
 * @param {Bundle} bundle
 *  
 * @returns {number[]} 
 */
export const getInputIndexesForBundle = (bundle: Bundle): number[] => {
    const { inputs } = bundle;

    return inputs.map((input) => input.index);
}

/**
 * Get all spent addresses from bundles
 */
export const spentAddressesFromBundles = derived(get(migration).bundles, (_bundles) => _bundles
    .filter((bundle) => bundle.migrated === false && bundle.shouldMine === true)
    .map((bundle) => Object.assign({}, bundle.inputs[0], {
        selectedToMine: bundle.selectedToMine,
        bundleHash: bundle.bundleHash,
        crackability: bundle.crackability
    }))
)

/**
 * Determines if we only have a single bundle to migrate
 */
export const hasSingleBundle = derived(get(migration).bundles, (_bundles) => _bundles.length === 1 && _bundles[0].selected === true)

/**
 * Determines if we have bundles with spent addresses
 */
export const hasBundlesWithSpentAddresses = derived(get(migration).bundles, (_bundles) => _bundles.length && _bundles.some((bundle) => bundle.shouldMine === true &&
    bundle.selected === true))

/**
 * Toggles mining selection
 * 
 * @method toggleMiningSelection
 * 
 * @param {Address} address
 * 
 * @returns {void} 
 */
export const toggleMiningSelection = (address: Address): void => {
    const { bundles } = get(migration)

    bundles.update((_bundles) => _bundles.map((bundle) => {
        if (bundle.inputs.some((input) => input.address === address.address)) {
            return Object.assign({}, bundle, { selectedToMine: !bundle.selectedToMine })
        }

        return bundle
    }))
}

/**
 * Selects all addresses for mining
 * 
 * @method selectAllAddressesForMining
 * 
 * @returns {void}
 */
export const selectAllAddressesForMining = (): void => {
    const { bundles } = get(migration)
    bundles.update((_bundles) => _bundles.map((bundle) => {
        if (bundle.shouldMine) {
            return Object.assign({}, bundle, { selectedtoMine: true })
        }
        return bundle
    }))
}

/**
 * Resets migration state
 * 
 * @method resetMigrationState
 * 
 * @returns {void}
 */
export const resetMigrationState = (): void => {
    const { didComplete, data, seed, bundles } = get(migration)
    didComplete.set(false)
    data.set({
        lastCheckedAddressIndex: 0,
        balance: 0,
        inputs: []
    })
    seed.set(null)
    bundles.set([])
}

/**
 * All selected bundles for mining
 */
export const selectedBundlesToMine = derived(get(migration).bundles, (_bundles) => _bundles.filter((bundle) =>
    bundle.selectedToMine === true &&
    bundle.shouldMine === true
))

/**
 * All selected bundles that are yet to migrate
 */
export const unmigratedBundles = derived(get(migration).bundles, (_bundles) => _bundles.filter((bundle) =>
    bundle.selected === true &&
    bundle.migrated === false
))

/**
 * Determines if we have migrated all bundles
 */
export const hasMigratedAllBundles = derived(get(migration).bundles, (_bundles) => _bundles.length && _bundles.every((bundle) =>
    bundle.selected === true &&
    bundle.migrated === true
))

/**
 * Determines if we have migrated any bundle
 */
export const hasMigratedAnyBundle = derived(get(migration).bundles, (_bundles) => _bundles.some((bundle) =>
    bundle.selected === true &&
    bundle.migrated === true
))

/**
 * Determines if we have migrated all selected bundles
 */
export const hasMigratedAllSelectedBundles = derived(get(migration).bundles, (_bundles) => {
    const selectedBundles = _bundles.filter((bundle) => bundle.selected === true)

    return selectedBundles.length && selectedBundles.every((bundle) => bundle.migrated === true)
});

/**
 * Determines if all migrated bundles are confirmed
 */
export const hasMigratedAndConfirmedAllSelectedBundles = derived(get(migration).bundles, (_bundles) => {
    const selectedBundles = _bundles.filter((bundle) => bundle.selected === true)

    return selectedBundles.length && selectedBundles.every((bundle) => bundle.migrated === true && bundle.confirmed === true)
});

/**
 * Total migration balance
 */
export const totalMigratedBalance = derived(get(migration).bundles, (_bundles) => {
    return _bundles.reduce((acc, bundle) => {
        if (bundle.selected && bundle.migrated) {
            return acc + bundle.inputs.reduce((_acc, input) => _acc + input.balance, 0)
        }

        return acc
    }, 0)
})

/**
 * Determines if all spent addresses have low (less than MINIMUM MIGRATION) balance
 */
export const hasLowBalanceOnAllSpentAddresses = derived(get(migration).bundles, (_bundles) => {
    const bundlesWithSpentAddresses = _bundles.filter((bundle) =>
        bundle.shouldMine === true
    );

    return bundlesWithSpentAddresses.length && bundlesWithSpentAddresses.every((bundle) => bundle.inputs.every((input) => input.balance < MINIMUM_MIGRATION_BALANCE))
})

/**
 * Bundles with unspent addresses as inputs
 */
export const bundlesWithUnspentAddresses = derived(get(migration).bundles, (_bundles) => _bundles.filter((bundle) =>
    bundle.selected === true &&
    bundle.shouldMine === false
))

/**
 * Determines if there is any spent address with associated (previous) bundle hashes
 */
export const hasAnySpentAddressWithNoBundleHashes = derived(get(migration).bundles, (_bundles) => _bundles.length &&
    _bundles.some((bundle) => bundle.inputs.some((input) => input.spent && ((Array.isArray(input.spentBundleHashes) && !input.spentBundleHashes.length) || input.spentBundleHashes === null))))


/**
 * All spent address that have no bundle hashes
 */
export const spentAddressesWithNoBundleHashes = derived([get(migration).data, get(migration).bundles], ([data]) => data.inputs.filter((input) => input.spent && input.balance >= MINIMUM_MIGRATION_BALANCE && ((Array.isArray(input.spentBundleHashes) && !input.spentBundleHashes.length) || input.spentBundleHashes === null)))

/**
 * Inputs that were not selected for migration (have low balance)
 */
export const unselectedInputs = derived([get(migration).data, get(migration).bundles], ([data, bundles]) => {
    return data.inputs.filter((input) => !bundles.some((bundle) => bundle.inputs.some((bundleInput) => bundleInput.address === input.address)))
})

/**
 * All confirmed bundles
 */
export const confirmedBundles = derived(get(migration).bundles, (_bundles) => _bundles.filter((bundle) =>
    bundle.selected === true &&
    bundle.confirmed === true
))

/**
 * List of chrysalis node endpoints to detect when is live
 */
export const CHRYSALIS_NODE_ENDPOINTS = ['https://chrysalis-nodes.iota.org/api/v1/info', 'https://chrysalis-nodes.iota.cafe/api/v1/info']

/**
* Default timeout for a request made to an endpoint
*/
const DEFAULT_CHRYSALIS_NODE_ENDPOINT_TIMEOUT = 5000
/**
 * Default interval for polling the market data
 */
const DEFAULT_CHRYSALIS_NODE_POLL_INTERVAL = 300000 // 5 minutes

/**
* Mainnet ID used in a chrysalis node 
*/
// TODO: Update to 'mainnet'
const MAINNET_ID = getOfficialNetwork()

type ChrysalisNode = {
    data: ChrysalisNodeData
}

type ChrysalisNodeData = {
    networkId: string
}

export type ChrysalisNodeDataValidationResponse = {
    type: 'ChrysalisNode'
    payload: ChrysalisNode
}

let chrysalisStatusIntervalID = null

/**
 * Poll the Chrysalis mainnet status at an interval
 */
export async function pollChrysalisStatus(): Promise<void> {
    await checkChrysalisStatus()
    chrysalisStatusIntervalID = setInterval(async () => checkChrysalisStatus(), DEFAULT_CHRYSALIS_NODE_POLL_INTERVAL)
}

/**
 * Stops Chrysalis mainnet poll
 */
function stopChrysalisStatusPoll(): void {
    if (chrysalisStatusIntervalID) {
        clearInterval(chrysalisStatusIntervalID)
    }
}

/**
 * Fetches Chrysalis mainnet status
 *
 * @method fetchMarketData
 *
 * @returns {Promise<void>}
 */
export async function checkChrysalisStatus(): Promise<void> {
    const requestOptions: RequestInit = {
        headers: {
            Accept: 'application/json',
        },
    }
    for (let index = 0; index < CHRYSALIS_NODE_ENDPOINTS.length; index++) {
        const endpoint = CHRYSALIS_NODE_ENDPOINTS[index]
        try {
            const abortController = new AbortController()
            const timerId = setTimeout(
                () => {
                    if (abortController) {
                        abortController.abort();
                    }
                },
                DEFAULT_CHRYSALIS_NODE_ENDPOINT_TIMEOUT);

            requestOptions.signal = abortController.signal;

            const response = await fetch(endpoint, requestOptions);

            clearTimeout(timerId)

            const jsonResponse: ChrysalisNode = await response.json()

            const { isValid, payload } = new Validator().performValidation({
                type: 'ChrysalisNode',
                payload: jsonResponse,
            })
            if (isValid) {
                const nodeData: ChrysalisNodeData = jsonResponse?.data
                if (nodeData?.networkId === MAINNET_ID) {
                    chrysalisLive.set(true)
                    stopChrysalisStatusPoll()
                    break
                }
            } else {
                throw new Error(payload.error)
            }
            break
        } catch (err) {
            console.error(err.name === "AbortError" ? new Error(`Could not fetch from ${endpoint}.`) : err)
        }
    }
}

const CHRYSALIS_VARIABLES_ENDPOINT = 'https://raw.githubusercontent.com/iotaledger/firefly/develop/packages/shared/lib/chrysalis.json'
const DEFAULT_CHRYSALIS_VARIABLES_ENDPOINT_TIMEOUT = 5000
const DEFAULT_CHRYSALIS_VARIABLES_POLL_INTERVAL = 60000 // 1 minute

type ChrysalisVariables = {
    snapshot: boolean
}

export type ChrysalisVariablesValidationResponse = {
    type: 'ChrysalisVariables'
    payload: ChrysalisVariables
}

/**
 * Fetches Chrysalis snapshot state
 *
 * @method checkChrysalisSnapshot
*
 * @returns {Promise<void>}
 */
export async function checkChrysalisSnapshot(): Promise<void> {
    const requestOptions: RequestInit = {
        headers: {
            Accept: 'application/json',
        }
    }
    const endpoint = CHRYSALIS_VARIABLES_ENDPOINT
    try {
        const abortController = new AbortController()
        const timerId = setTimeout(
            () => {
                if (abortController) {
                    abortController.abort();
                }
            },
            DEFAULT_CHRYSALIS_VARIABLES_ENDPOINT_TIMEOUT);

        requestOptions.signal = abortController.signal;

        const response = await fetch(endpoint, requestOptions);

        clearTimeout(timerId)

        const jsonResponse: ChrysalisVariables = await response.json()

        const { isValid, payload } = new Validator().performValidation({
            type: 'ChrysalisVariables',
            payload: jsonResponse,
        })
        if (isValid) {
            const _ongoingSnapshot = jsonResponse.snapshot
            if (get(ongoingSnapshot) === true && _ongoingSnapshot === false) { // snapshot finished
                closePopup()
            }
            ongoingSnapshot.set(_ongoingSnapshot)
        } else {
            throw new Error(payload.error)
        }
    } catch (err) {
        console.error(err.name === "AbortError" ? new Error(`Could not fetch from ${endpoint}.`) : err)
    }
}

/**
 * Poll the Chrysalis snapshot state at an interval
 */
export async function pollChrysalisSnapshot(stopPoll: boolean = true): Promise<void> {
    await checkChrysalisSnapshot()
    setInterval(async () => checkChrysalisSnapshot(), DEFAULT_CHRYSALIS_VARIABLES_POLL_INTERVAL)
}

export function openSnapshotPopup(): void {
    openPopup({
        type: 'snapshot',
        hideClose: true,
        props: {
            dashboard: get(appRoute) === AppRoute.Dashboard || get(appRoute) === AppRoute.Login
        }
    })
}

/**
 * Initialise migration process listeners
 */
export const initialiseMigrationListeners = () => {
    api.onMigrationProgress({
        onSuccess(response) {
            if (response.payload.event.type === 'TransactionConfirmed') {
                const { bundles } = get(migration)

                bundles.update((_bundles) => _bundles.map((bundle) => {
                    // @ts-ignore
                    if (bundle.bundleHash && bundle.bundleHash === response.payload.event.data.bundleHash) {
                        return Object.assign({}, bundle, { confirmed: true })
                    }

                    return bundle
                }))
            }
        }, onError(error) {
            console.log('Error', error)
        }
    })
}

export const asyncGetAddressChecksum = (address: string = '', legacy: boolean = false): Promise<string> => {
    const _checksum = (_address: string = '') => _address.slice(-CHECKSUM_LENGTH)
    return new Promise<string>((resolve, reject) => {
        if (legacy) {
            api.getLegacyAddressChecksum(address, {
                onSuccess(response) {
                    const checksum = _checksum(response.payload)
                    resolve(checksum)
                },
                onError(err) {
                    reject(err)
                },
            })
        } else {
            const checksum = _checksum(address)
            resolve(checksum)
        }
    })
}

function openLedgerLegacyTransactionPopup(transfer: Transfer, inputs: Input[]): void {
    openPopup({
        type: 'ledgerLegacyTransaction',
        hideClose: true,
        preventClose: true,
        props: {
            transfer, inputs
        }
    })
}
