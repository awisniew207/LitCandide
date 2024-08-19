import { LitNodeClient } from "@lit-protocol/lit-node-client";
import {
  GoogleProvider,
  LitAuthClient,
} from "@lit-protocol/lit-auth-client";
import { ProviderType, LitNetwork, LIT_RPC } from "@lit-protocol/constants";
import { PKPEthersWallet } from "@lit-protocol/pkp-ethers";
import { LitAbility, LitPKPResource } from "@lit-protocol/auth-helpers";
import { AuthCallbackParams, AuthMethod } from "@lit-protocol/types";
import {
  SafeAccountV0_2_0 as SafeAccount,
  SocialRecoveryModule,
  CandidePaymaster,
} from "abstractionkit";

const ownerPublicAddress = import.meta.env.VITE_OWNER_PUBLIC_ADDRESS;
const newOwnerPublicAddress = import.meta.env.VITE_NEW_OWNER_PUBLIC_ADDRESS;
const jsonRpcNodeProvider = import.meta.env.VITE_JSON_RPC_PROVIDER;
const bundlerUrl = import.meta.env.VITE_BUNDLER_URL;
const chainId = BigInt(import.meta.env.VITE_CHAIN_ID);

const paymaster = new CandidePaymaster(import.meta.env.VITE_PAYMASTER_URL);
const smartAccount: SafeAccount = SafeAccount.initializeNewAccount([ownerPublicAddress]);
const srm: SocialRecoveryModule = new SocialRecoveryModule();

let guardianSigner: any;
let guardianSmartAccount: SafeAccount;
let guardianSignerAddress: string = '';

const litSignIn = async () => {
  const initalizeClientsAndProvider = async () => {
    // Connect to the Lit Network through the LitNodeClient
    const litNodeClient = new LitNodeClient({
      litNetwork: LitNetwork.DatilDev,
      debug: true,
    });
    await litNodeClient.connect();

    // Use LitAuthClient to handle authentication through the Lit login
    const litAuthClient = new LitAuthClient({
      litRelayConfig: {
        relayApiKey: import.meta.env.VITE_LIT_API_KEY,
      },
      litNodeClient,
    });

    //await litContractsClient.connect();
    console.log("Connected to Lit Node and Lit Auth Clients ✔️");

    // Initialize a GoogleProvider instance through the LitAuthClient
    // Specifying the redirectUri after successful authentication
    const provider = litAuthClient.initProvider<GoogleProvider>(
      ProviderType.Google,
      {}
    );
  
    // Return the LitNodeClient, LitAuthClient, and GoogleProvider objects
    return { litNodeClient, litAuthClient, provider };
  };

  const { litNodeClient, litAuthClient, provider } =
    await initalizeClientsAndProvider();

  const generateAuthMethod = async () => {
    // Get the current URL
    const url = new URL(window.location.href);

    // If the 'provider' parameter is not present, that indicates Google sign-in
    // has not yet happened. We will open a sign in window for the user.
    if (!url.searchParams.get("provider")) {
      console.log("Signing in with Google...");
      provider.signIn((url: string) => {
        window.location.href = url;
      });
    }

    // Otherwise, the user has already authenticated with Google and we can
    // generate an AuthMethod. After minting, we can fetch the PKP using the same AuthMethod.
    else if (url.searchParams.get("provider") === "google") {
      const authMethod = await provider.authenticate();
      return authMethod;
    }
  };

  const authMethod = await generateAuthMethod();
  if (!authMethod) {
    return;
  }

  const mintWithGoogle = async (authMethod: AuthMethod) => {
    const pkp = await litAuthClient.mintPKPWithAuthMethods([authMethod], {addPkpEthAddressAsPermittedAddress: true})
    console.log("Fetched PKP", pkp)
    return pkp;
  };
  
  // Fetch PKPs using the generated AuthMethod
  let pkp;
  let pkps = await provider.fetchPKPsThroughRelayer(authMethod);

  // If the AuthMethod has no PKPs, mint a new one with the AuthMethod generated from Google sign-in
  if (pkps.length === 0) {
    await mintWithGoogle(authMethod);
    pkps = await provider.fetchPKPsThroughRelayer(authMethod);
  }
  
  // If we did not mint a new PKP, that means we already had one minted to the AuthMethod
  pkp = pkps[0];

  const authNeededCallback = async (params: AuthCallbackParams) => {
    const response = await litNodeClient.signSessionKey({
      statement: params.statement,
      authMethods: [authMethod],
      resourceAbilityRequests: [
        {
          resource: new LitPKPResource("*"),
          ability: LitAbility.PKPSigning,
        },
      ],
      expiration: params.expiration,
      resources: params.resources,
      chainId: 1,
      pkpPublicKey: pkp.publicKey,
    });
    return response.authSig;
  };

  const guardianSigner = new PKPEthersWallet({
    litNodeClient,
    authContext: {
      getSessionSigsProps: {
        chain: "ethereum",
        expiration: new Date(Date.now() + 60_000 * 60).toISOString(),
        resourceAbilityRequests: [
          {
            resource: new LitPKPResource("*"),
            ability: LitAbility.PKPSigning,
          },
        ],
        authNeededCallback: authNeededCallback,
      },
    },
    pkpPubKey: pkp.publicKey,
    rpc: LIT_RPC.CHRONICLE_YELLOWSTONE,
  });
  console.log("Token ID", pkp.tokenId)
  console.log("Created PKPEthersWallet using the PKP ✔️");

  return guardianSigner;
};

export const initializeGuardianSigner = async () => {
  if (!guardianSigner) {
    guardianSigner = await litSignIn();
  }

  if(guardianSigner) {
    guardianSignerAddress = await guardianSigner.getAddress();
    guardianSmartAccount = SafeAccount.initializeNewAccount([guardianSignerAddress]);
    console.log("Guardian Smart Account Initialized");
  }
};

export const addGuardian = async () => {
  // Ensure that the guardianSigner and guardianSmartAccount have been initialized
  if (!guardianSigner || !guardianSmartAccount) {
    throw new Error("Guardian Signer or Guardian Smart Account is not initialized.");
  }

  // Enable Module Meta Transaction (Only when initializing a new smartAccount for the first time)
  const enableModuleTx = srm.createEnableModuleMetaTransaction(
    smartAccount.accountAddress
  );

  // Create Add Guardian Meta Transaction
  const addGuardianTx = srm.createAddGuardianWithThresholdMetaTransaction(
    smartAccount.accountAddress,
    guardianSmartAccount.accountAddress, // Lit Guardian Address
    1n // threshold
  );

  // Prepare userOperation
  let userOperation = await smartAccount.createUserOperation(
    [enableModuleTx, addGuardianTx], // enableModuleTx,
    jsonRpcNodeProvider,
    bundlerUrl
  );

  // Add gas sponsorship info using paymaster
  userOperation = await paymaster.createSponsorPaymasterUserOperation(
    userOperation,
    bundlerUrl
  );

  // Sign userOperation
  userOperation.signature = smartAccount.signUserOperation(
    userOperation,
    [import.meta.env.VITE_OWNER_PRIVATE_KEY],
    chainId
  );

  // Submit userOperation
  const sendUserOperationResponse = await smartAccount.sendUserOperation(
    userOperation,
    bundlerUrl
  );

  // Monitor and wait for receipt
  console.log("userOperation sent. Waiting to be included ......");
  const userOperationReceiptResult = await sendUserOperationResponse.included();
  console.log("Included ✔️");

  // Check for success or error
  if (userOperationReceiptResult.success) {
    console.log(
      "Successful Useroperation. The transaction hash is: " +
        userOperationReceiptResult.receipt.transactionHash
    );
    const isGuardian = await srm.isGuardian(
      jsonRpcNodeProvider,
      smartAccount.accountAddress,
      guardianSmartAccount.accountAddress
    );
    if (isGuardian) {
      console.log(
        "Guardian added confirmed ✔️. Guardian address is: " +
          guardianSmartAccount.accountAddress
      );
    } else {
      console.log("Adding guardian failed.");
    }
  } else {
    console.log("Useroperation execution failed");
  }
};

// Prepare Recovery tx
export const beginRecovery = async() => {
  
  const initiateRecoveryMetaTx = srm.createConfirmRecoveryMetaTransaction(
    smartAccount.accountAddress,
    [newOwnerPublicAddress],
    1, // new threshold
    true // whether to auto-start execution of recovery
  );

  // Send Transaction using guardian signer
  console.log("Trying to send Tx using Guardian Signer");
  let userOperationRecovery = await guardianSmartAccount.createUserOperation(
    [initiateRecoveryMetaTx],
    jsonRpcNodeProvider,
    bundlerUrl
  );
  console.log("Sent ✔️")

  // Add gas sponsorship info using paymaster
  console.log("Trying to add gas sponsorship using paymaster");
  userOperationRecovery = await paymaster.createSponsorPaymasterUserOperation(
    userOperationRecovery,
    bundlerUrl
  );
  console.log("Added ✔️")

  // Sign userOperation
  console.log("Trying to sign userOperation");
  
  const domain = {
    chainId,
    verifyingContract: guardianSmartAccount.safe4337ModuleAddress,
  };
  
  const types = SafeAccount.EIP712_SAFE_OPERATION_TYPE;
  const { sender, ...userOp } = userOperationRecovery;
  const safeUserOperation = {
    ...userOp,
    safe: userOperationRecovery.sender,
    validUntil: BigInt(0),
    validAfter: BigInt(0),
    entryPoint: guardianSmartAccount.entrypointAddress,
  };
  const signature = await guardianSigner._signTypedData(domain, types, safeUserOperation);
  const formatedSig = SafeAccount.formatEip712SignaturesToUseroperationSignature([guardianSignerAddress], [signature]);
  userOperationRecovery.signature = formatedSig; 

  console.log(
    "userOperationRecovery signature ✔️",
    userOperationRecovery.signature
  );
  console.log(
    "Current Smart Account Guardians:",
    await srm.getGuardians(jsonRpcNodeProvider, smartAccount.accountAddress)
  );
  console.log("Guardian address:", guardianSmartAccount.accountAddress);
  // Submit userOperation
  console.log("Trying to send userOperation");
  const sendUserOperationResponseRecovery =
    await guardianSmartAccount.sendUserOperation(
      userOperationRecovery,
      bundlerUrl
    );
    console.log("Sent ✔️")

  // Monitor and wait for receipt
  console.log("Useroperation sent. Waiting to be included ......");
  const userOperationReceiptResultRecovery =
    await sendUserOperationResponseRecovery.included();
  console.log("Useroperation included:", userOperationReceiptResultRecovery.receipt.transactionHash);
  const recoveryTime = new Date(Date.now() + 180_000);
  const formattedRecoveryTime = recoveryTime.toLocaleString();
  
  console.log("❗❗❗ The recovery has been sent. The recovery can be finalized in 3 minutes, at: ", formattedRecoveryTime, " ❗❗❗");
  
};

// Can only finalize after grace period is over
export const finalizeRecovery = async () => {
  const smartAccount = SafeAccount.createAccountAddressAndInitCode([
    ownerPublicAddress,
  ]);
  const smartAccountAddress = smartAccount[0];

  if (!guardianSigner) {
    throw new Error("Guardian Signer is not initialized. Call addGuardian first.");
  }

  const guardianSignerAddress = await guardianSigner.getAddress();

  const finalizeRecoveryMetaTx =
    srm.createFinalizeRecoveryMetaTransaction(smartAccountAddress);
    const guardianSmartAccount = SafeAccount.initializeNewAccount(
      [guardianSignerAddress]
    );

  let userOperationRecovery = await guardianSmartAccount.createUserOperation(
    [finalizeRecoveryMetaTx],
    jsonRpcNodeProvider,
    bundlerUrl
  );

  userOperationRecovery = await paymaster.createSponsorPaymasterUserOperation(
    userOperationRecovery,
    bundlerUrl
  );

  // Add gas sponsorship info using paymaster
  userOperationRecovery = await paymaster.createSponsorPaymasterUserOperation(
    userOperationRecovery,
    bundlerUrl
  );

  const domain = {
    chainId,
    verifyingContract: guardianSmartAccount.safe4337ModuleAddress,
  };
  
  const types = SafeAccount.EIP712_SAFE_OPERATION_TYPE;
  const { sender, ...userOp } = userOperationRecovery;
  const safeUserOperation = {
    ...userOp,
    safe: userOperationRecovery.sender,
    validUntil: BigInt(0),
    validAfter: BigInt(0),
    entryPoint: guardianSmartAccount.entrypointAddress,
  };
  const signature = await guardianSigner._signTypedData(domain, types, safeUserOperation);
  const formatedSig = SafeAccount.formatEip712SignaturesToUseroperationSignature([guardianSignerAddress], [signature]);
  userOperationRecovery.signature = formatedSig;

  // Submit userOperation
  const sendUserOperationResponseRecovery =
    await guardianSmartAccount.sendUserOperation(
      userOperationRecovery,
      bundlerUrl
    );

  // Monitor and wait for receipt
  console.log("Useroperation sent. Waiting to be included ......");
  const userOperationReceiptResultRecovery =
    await sendUserOperationResponseRecovery.included();
  console.log(userOperationReceiptResultRecovery.receipt.transaction);
  console.log("Recovery Completed!")
};