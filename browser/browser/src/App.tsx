import React, { useState, useEffect, ReactNode } from 'react';
import { addGuardian, beginRecovery, finalizeRecovery, initializeGuardianSigner } from "./connect";

// ErrorBoundary Component to catch errors in child components
interface ErrorBoundaryProps {
  children: ReactNode;
  setConsoleOutput: React.Dispatch<React.SetStateAction<{ type: 'error' | 'log'; message: string }[]>>;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, { hasError: boolean; errorInfo: string }> {
  state = { hasError: false, errorInfo: '' };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ errorInfo: info.componentStack || '' });
    this.props.setConsoleOutput(prev => [...prev, { type: 'error', message: `Error: ${error.message}\n${info.componentStack || ''}` }]);
  }

  render() {
    if (this.state.hasError) {
      return <h1>Something went wrong. Check console output for details.</h1>;
    }

    return this.props.children;
  }
}

function App() {
  const [consoleOutput, setConsoleOutput] = useState<{ type: 'error' | 'log'; message: string }[]>([]);
  const [isGoogleProvider, setIsGoogleProvider] = useState(false);
  const [isVerified, setIsVerified] = useState(false); // New state to track verification

  useEffect(() => {
    const url = new URL(window.location.href);
    const provider = url.searchParams.get("provider") ?? "";
    setIsGoogleProvider(provider === "google");

    // Function to safely stringify any value, including BigInt
    const safeStringify = (obj: any): string => {
      return JSON.stringify(obj, (_, value) =>
        typeof value === 'bigint'
          ? value.toString()
          : value
      );
    };

    // Save original console methods
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;

    // Define new console methods
    const newConsoleLog = (...args: any[]) => {
      originalConsoleLog.apply(console, args);
      setConsoleOutput(prev => [...prev, { type: 'log', message: args.map(arg => 
        typeof arg === 'object' ? safeStringify(arg) : String(arg)
      ).join(' ') }]);
    };

    const newConsoleError = (...args: any[]) => {
      setConsoleOutput(prev => [...prev, { type: 'error', message: args.map(arg => 
        typeof arg === 'object' ? safeStringify(arg) : String(arg)
      ).join(' ') }]);
    };

    // Override console methods
    console.log = newConsoleLog;
    console.error = newConsoleError;

    // Handle unhandled promise rejections
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled rejection:', event.reason);
      setConsoleOutput(prev => [...prev, { type: 'error', message: `Unhandled rejection: ${event.reason}` }]);
    };

    // Add event listener for unhandledrejection
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    // Cleanup function to restore original console methods and remove event listeners
    return () => {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };

  }, []);

  const handleVerifyGoogleAccount = async () => {
    await initializeGuardianSigner();
    setIsVerified(true); // Update state to indicate verification
  };

  return (
    <ErrorBoundary setConsoleOutput={setConsoleOutput}>
      <div className="card">
        <hr />
        <h3>Simple Lit + Candide code</h3>
        <button onClick={handleVerifyGoogleAccount}>
          {isGoogleProvider ? "Verify Google Account" : "Sign into Google"}
        </button>
        <button onClick={async () => await addGuardian()} disabled={!isVerified}>
          Add Guardian
        </button>
        <button onClick={async () => await beginRecovery()} disabled={!isVerified}>
          Begin Recovery
        </button>
        <button onClick={async () => await finalizeRecovery()} disabled={!isVerified}>
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
            <div key={index} style={{ color: log.type === 'error' ? 'red' : 'black' }}>
              {log.message}
            </div>
          ))}
        </div>
        <hr />
        <img src="litlogo.jpg" alt="Lit Image" />
        <img src="candide.jpg" alt="Candide image" />
      </div>
    </ErrorBoundary>
    
  );
}

export default App;
