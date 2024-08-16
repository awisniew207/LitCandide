import React, { useState, useEffect } from 'react';
import { addGuardian, beginRecovery, finalizeRecovery, initializeGuardianSigner } from "./connect";

function App() {
  const [consoleOutput, setConsoleOutput] = useState<string[]>([]);
  const [isGoogleProvider, setIsGoogleProvider] = useState(false);


  useEffect(() => {
    const url = new URL(window.location.href);
    setIsGoogleProvider(url.searchParams.get("provider") === "google");
    // Function to safely stringify any value, including BigInt
    const safeStringify = (obj: any): string => {
      return JSON.stringify(obj, (_, value) =>
        typeof value === 'bigint'
          ? value.toString()
          : value
      );
    };

    // Override console.log
    const originalConsoleLog = console.log;
    console.log = function(...args) {
      originalConsoleLog.apply(console, args);
      setConsoleOutput(prev => [...prev, args.map(arg => 
        typeof arg === 'object' ? safeStringify(arg) : String(arg)
      ).join(' ')]);
    };

    // Cleanup function to restore original console.log
    return () => {
      console.log = originalConsoleLog;
    };
  }, []);

  return (
    <>
      <div className="card">
        <hr />
        <h3>Simple Lit + Candide code</h3>
        <button onClick={async () => await initializeGuardianSigner()}>
          {isGoogleProvider ? "Verify Google Account" : "Sign into Google"}
        </button>
        <button onClick={async () => await addGuardian()}>
          Add Guardian
        </button>
        <button onClick={async () => await beginRecovery()}>
          Begin Recovery
        </button>
        <button onClick={async () => await finalizeRecovery()}>
          Finalize Recovery
        </button>
        <h5>Console Output:</h5>
        <div id="console-output" style={{
          border: '1px solid #ccc',
          padding: '10px',
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          height: '300px',
          overflowY: 'auto'
        }}>
          {consoleOutput.map((log, index) => (
            <div key={index}>{log}</div>
          ))}
        </div>
        <hr />
      </div>
    </>
  );
}

export default App;