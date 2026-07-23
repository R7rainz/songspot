import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles.css";
import { Home } from "./pages/Home";
import { Room } from "./pages/Room";
import { Join } from "./pages/Join";
import { ErrorPage } from "./pages/ErrorPage";

const router = createBrowserRouter([
  { path: "/", element: <Home />, errorElement: <ErrorPage /> },
  { path: "/room/:roomID", element: <Room />, errorElement: <ErrorPage /> },
  { path: "/join/:token", element: <Join />, errorElement: <ErrorPage /> },
  { path: "*", element: <Home /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
