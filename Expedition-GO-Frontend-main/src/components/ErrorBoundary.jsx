import { Component } from "react";

import { Button } from "@/components/ui/button";
import { devError } from "@/lib/logger";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    devError("[ErrorBoundary]", error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { goHomeLink = "/", goHomeLabel = "Go Home", goAdminLink, goAdminLabel } = this.props;

    if (error) {
      return (
        <div className="flex min-h-[60vh] items-center justify-center px-4">
          <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-lg">
            <h2 className="text-lg font-semibold text-slate-900">Something went wrong</h2>
            <p className="mt-2 text-sm text-slate-600">
              {error?.message || "An unexpected error occurred while rendering this view."}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button type="button" onClick={this.reset}>
                Try again
              </Button>
              <Button type="button" variant="outline" onClick={() => window.location.assign(goHomeLink)}>
                {goHomeLabel}
              </Button>
              {goAdminLink && (
                <Button type="button" variant="outline" onClick={() => window.location.assign(goAdminLink)}>
                  {goAdminLabel || "Open admin"}
                </Button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
