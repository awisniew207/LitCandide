import { LitNodeClient } from "@lit-protocol/lit-node-client";
import {
  EthWalletProvider,
  GoogleProvider,
  LitAuthClient,
} from "@lit-protocol/lit-auth-client";
import { ProviderType, AuthMethodScope } from "@lit-protocol/constants";
import { LitContracts } from "@lit-protocol/contracts-sdk";
import { PKPEthersWallet } from "@lit-protocol/pkp-ethers";
import { LitAbility, LitActionResource, LitPKPResource } from "@lit-protocol/auth-helpers";
import { AuthCallbackParams, AuthMethod } from "@lit-protocol/types";
import { ethers } from "ethers";
import {
  SafeAccountV0_2_0 as SafeAccount,
  SocialRecoveryModule,
  CandidePaymaster,
  createUserOperationHash,
} from "abstractionkit";

const ownerPublicAddress = "0xE4c711d31fe110bC4AD3A964d06088c2723de88E";
const newOwnerPublicAddress = "0xB0DA0323CD3604EfFDa69C3fD7645D30206E23B3";
const jsonRpcNodeProvider =
  "https://eth-sepolia.g.alchemy.com/v2/HbaO4KM-hwt9C1MoCWkDn1WAiFyDDprn"; //"https://vesuvius-rpc.litprotocol.com"
const bundlerUrl = "https://sepolia.voltaire.candidewallet.com/rpc";

const litcode = async () => {
  const initalizeClientsAndProvider = async () => {
    // Connect to the Lit Network through the LitNodeClient
    const litNodeClient = new LitNodeClient({
      litNetwork: "datil-dev",
      debug: true,
    });
    await litNodeClient.connect();

    // Use LitAuthClient to handle authentication through the Lit login
    const litAuthClient = new LitAuthClient({
      litRelayConfig: {
        relayApiKey: "Anything",
      },
      litNodeClient,
    });

    //await litContractsClient.connect();
    console.log("Connected to Lit Node and Lit Auth Clients ✔️");

    // Initialize a GoogleProvider instance through the LitAuthClient
    // Specifying the redirectUri after successful authentication
    const provider = litAuthClient.initProvider<GoogleProvider>(
      ProviderType.Google,
      {
        //redirectUri: VITE_REDIRECT_URI, temporarily commented out for dev
      }
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
    // generate an AuthMethod, save it to local storage, and use it to mint
    // a PKP. After minting, we can fetch the PKP using the same AuthMethod.
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
    //const mintTx = await provider.mintPKPThroughRelayer(authMethod, {
      //permittedAuthMethodScopes: [[AuthMethodScope.SignAnything]],
    //});
    const pkp = await litAuthClient.mintPKPWithAuthMethods([authMethod], {addPkpEthAddressAsPermittedAddress: true})
    //console.log("Mint Tx", mintTx);
    //const pkp = await provider.fetchPKPsThroughRelayer(authMethod);
    console.log("Fetched PKP", pkp)
    return pkp;
  };

  const pkp = await mintWithGoogle(authMethod);

  console.log("Minted PKP ✔️");
  if (!pkp.pkpPublicKey){
    return
  }

  const authNeededCallback = async (params: AuthCallbackParams) => {
    const response = await litNodeClient.signSessionKey({
      statement: params.statement,
      authMethods: [authMethod],
      resourceAbilityRequests: 
      [      
        {
        resource: new LitPKPResource("*"),
        ability: LitAbility.PKPSigning,
      },
    ],
      expiration: params.expiration,
      resources: params.resources,
      chainId: 1,
      pkpPublicKey: pkp.pkpPublicKey
    });
    console.log("AUTHSIG", response)
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
            resource: new LitActionResource("*"),
            ability: LitAbility.PKPSigning,
          },
        ],
        authNeededCallback: authNeededCallback,
      },
    },
    pkpPubKey: pkp.pkpPublicKey,
    rpc: "https://yellowstone-rpc.litprotocol.com",
  });
  console.log("Token ID", pkp.pkpTokenId)
  console.log("Created PKPEthersWallet using the PKP ✔️");

  return guardianSigner;
};

export const addGuardian = async () => {
  const guardianSigner = await litcode();
  if (!guardianSigner) {
    throw new Error("Guardian Signer is undefined.");
  }

  const smartAccount = SafeAccount.initializeNewAccount([ownerPublicAddress]);
  console.log("Initialized Smart Account using ownerPublicAddress ✔️");

  // Add Lit Guardian
  const srm = new SocialRecoveryModule();

  const enableModuleTx = srm.createEnableModuleMetaTransaction(
    smartAccount.accountAddress
  ); // Only when initializing a new smartAccount for the first time

  const guardianSignerAddress = await guardianSigner.getAddress();
  if (!guardianSignerAddress) {
    throw new Error("Guardian Signer Address is undefined.");
  }
  const guardianSmartAccount = SafeAccount.initializeNewAccount([
    guardianSignerAddress,
  ]);
  const addGuardianTx = srm.createAddGuardianWithThresholdMetaTransaction(
    smartAccount.accountAddress,
    guardianSmartAccount.accountAddress, // Lit Guardian Address
    1n //threshold
  );

  // Prepare userOperation
  let userOperation = await smartAccount.createUserOperation(
    [addGuardianTx],
    jsonRpcNodeProvider,
    bundlerUrl
  );

  // Add gas sponsorship info using paymaster
  const paymasterUrl = import.meta.env.VITE_PAYMASTER_URL;
  const paymaster: CandidePaymaster = new CandidePaymaster(paymasterUrl);
  userOperation = await paymaster.createSponsorPaymasterUserOperation(
    userOperation,
    bundlerUrl
  );

  // Sign userOperation
  userOperation.signature = smartAccount.signUserOperation(
    userOperation,
    [import.meta.env.VITE_OWNER_PRIVATE_KEY],
    import.meta.env.VITE_CHAIN_ID
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

  // check for success or error
  if (userOperationReceiptResult.success) {
    console.log(
      "Successful Useroperation. The transaction hash is : " +
        userOperationReceiptResult.receipt.transactionHash
    );
    const isGuardian = await srm.isGuardian(
      jsonRpcNodeProvider,
      smartAccount.accountAddress,
      guardianSmartAccount.accountAddress
    );
    if (isGuardian) {
      console.log(
        "Guardian added confirmed ✔️. Guardian address is : " +
          guardianSmartAccount.accountAddress
      );
    } else {
      console.log("Adding guardian failed.");
    }
  } else {
    console.log("Useroperation execution failed");
  }

  // Prepare Recovery tx

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
  /*
  const domain = {
    chainId: import.meta.env.VITE_CHAIN_ID,
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
  userOperationRecovery.signature = formatedSig; */
  const userOpHash = createUserOperationHash(userOperationRecovery, guardianSmartAccount.entrypointAddress, 11155111n);
  const signature = await guardianSigner.signMessage(ethers.utils.arrayify(userOpHash));
  userOperationRecovery.signature = signature;

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
  console.log(userOperationReceiptResultRecovery);
  /*
   const confirmRecoveryTx = await guardianSigner.sendTransaction({
       to: initiateRecoveryMetaTx.to,
       data: initiateRecoveryMetaTx.data,
       value: 0,
   }); */
};

// Can only finilize after grace period is over
export const finilizeRecovery = async () => {
  const smartAccount = SafeAccount.createAccountAddressAndInitCode([
    ownerPublicAddress,
  ]);
  const smartAccountAddress = smartAccount[0];
  console.log(smartAccountAddress);

  const guardianSmartAccount = SafeAccount.initializeNewAccount(
    [ownerPublicAddress],
    { c2Nonce: 1n }
  );

  const srm = new SocialRecoveryModule();
  const finalizeRecoveryMetaTx =
    srm.createFinalizeRecoveryMetaTransaction(smartAccountAddress);

  let userOperationRecovery = await guardianSmartAccount.createUserOperation(
    [finalizeRecoveryMetaTx],
    jsonRpcNodeProvider,
    bundlerUrl
  );

  const paymasterUrl = import.meta.env.VITE_PAYMASTER_URL;
  const paymaster: CandidePaymaster = new CandidePaymaster(paymasterUrl);
  userOperationRecovery = await paymaster.createSponsorPaymasterUserOperation(
    userOperationRecovery,
    bundlerUrl
  );

  // Add gas sponsorship info using paymaster
  userOperationRecovery = await paymaster.createSponsorPaymasterUserOperation(
    userOperationRecovery,
    bundlerUrl
  );

  // Sign userOperation
  userOperationRecovery.signature = guardianSmartAccount.signUserOperation(
    userOperationRecovery,
    [import.meta.env.VITE_OWNER_PRIVATE_KEY], // If no private key, sign an EIP-712
    import.meta.env.VITE_CHAIN_ID
  );

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
  console.log(userOperationReceiptResultRecovery);
  // Anyone can call the finilize function after the grace period is over
  // const finilizeRecoveryTx = await guardianSigner.sendTransaction({
  //   to: finalizeRecoveryMetaTx.to,
  //   data: finalizeRecoveryMetaTx.data,
  // });

  // console.log(finilizeRecoveryTx, "finilizeRecoveryTx");
};