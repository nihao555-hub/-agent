import { Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { ProjectWorkspace } from '@/pages/ProjectWorkspace';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectWorkspace />} />
      </Routes>
    </Layout>
  );
}
