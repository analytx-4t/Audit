import ImageUpload from "./components/ImageUpload";
import ExcelUpload from "./components/ExcelUpload";
import RenameImages from "./components/RenameImages";
import ExtractAddress from "./components/ExtractAddress";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import ErrorPage from "./pages/ErrorPage";
import Login from "./pages/LoginPage";
import { ToastContainer } from "react-toastify";
import MainLayout from "./layouts/MainLayout";

export const router = createBrowserRouter([
  {
    errorElement: <ErrorPage />,
    children: [
      {
        path: "/login",
        element: <Login />,
      },

      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <MainLayout />,
            children: [
              {
                path: "/",
                element: <ImageUpload />,
              },
              {
                path: "/combine",
                element: (
                  <>
                    {/* <ImageUpload /> */}
                    <ExcelUpload />
                  </>
                ),
              },
              {
                path: "/rename-images",
                element: <RenameImages />,
              },
              {
                path: "/extract-address",
                element: <ExtractAddress />,
              },
            ],
          },
        ],
      },
    ],
  },
]);

function App() {
  return (
    // <div className="app">
    //   <Header />
    //   <main className="main-content">
    //     <ImageUpload />
    //     <ExcelUpload />
    //   </main>
    // </div>
    <>
      <RouterProvider router={router} />
      <ToastContainer
        position="top-right"
        autoClose={3000}
        hideProgressBar={false}
        closeOnClick
        pauseOnHover
        draggable
      />
    </>
  );
}

export default App;
